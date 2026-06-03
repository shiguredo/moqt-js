# Fetch オブジェクトの Descending Group Order を実装する

- Priority: High
- Created: 2026-06-03
- Model: deepseek-v4-pro
- Branch: feature/add-descending-fetch-group-order
- Polished: 2026-06-03

## 目的

draft-ietf-moq-transport-18 で定義されている Fetch Object Fields の Descending Group Order が未実装であるため、追加する。

仕様上の根拠:

- Section 10.12.3 (Fetch Handling):
  > "A publisher MUST send fetched groups in the requested group order, either ascending or descending."

- Section 11.4.4.1 (Table 9):
  > "If the Group Order is Descending, the Group ID is the prior Object's Group ID minus the (Group ID Delta + 1). If the computed Group ID would be less than 0 or greater than 2^64-1, the Subscriber MUST close the Session with error 'PROTOCOL_VIOLATION'."

- Section 10.2.8 (GROUP ORDER Parameter): 値は Ascending (0x1) または Descending (0x2)。`If omitted from FETCH, the receiver uses Ascending (0x1)`。

現在は Ascending の計算式のみが実装されており、GROUP_ORDER parameter で Descending (0x02) が指定された場合に Fetch レスポンスの Group ID が正しくデコードできない。

## 優先度根拠

仕様上の MUST 要件（Section 10.12.3）に対応するための実装欠落であり、Descending Group Order を指定する Fetch で誤った Group ID が計算される。実際のデコード誤動作に直結するため High とする。

## 現状

### デコードパス

`src/dataStream.ts` `decodeFetchObjectFields` (line 1266) は常に Ascending:

```ts
groupId = context.groupId + delta + 1n;
```

`decodeFetchObjectFields` の呼び出し元は `src/session/stream.ts` `processFetchObjects` (line 41)。さらに `src/session.ts` の受信ループ (line 3704 付近) から呼ばれる。このコールチェーンのいずれにも `groupOrder` が渡されていない。

### エンコードパス（PBT / Relay 用）

`encodeFetchObjectFields` (line 1082) も常に Ascending:

```ts
const delta = fields.groupId - context.groupId - 1n;
```

### Group Order の取得元

クライアントが Fetch データストリームを処理する際の Group Order は、FETCH レスポンスの FETCH_OK から取得する。現在:

- `src/fetcher.ts` `FetcherImpl` には Group Order を保持するフィールドがない
- `src/fetcher.ts:105` `setFetchOkInfo` は Group Order を受け取っていない
- `src/session/bidi.ts:343` `bidiReadFetchResponse` は FETCH_OK から Group Order を抽出していない

デフォルト値は Ascending (0x1) とし、`processFetchObjects` → `decodeFetchObjectFields` まで伝搬させる経路を新設する必要がある。

## 設計方針

1. `FetcherImpl` に `groupOrder` フィールドを追加し、FETCH_OK 受信時に設定する（省略時は Ascending）
2. `processFetchObjects` のシグネチャに `groupOrder` を追加し、`decodeFetchObjectFields` まで伝搬させる
3. `decodeFetchObjectFields` で `groupOrder` に応じた計算式を分岐させる
4. 最初のオブジェクトは絶対値として扱い、Ascending/Descending 計算は 2 番目以降のオブジェクトにのみ適用する（Section 11.4.4.1: "The first Object MUST include a Group ID Delta and Object ID Delta, and these values are the absolute Group ID and Object ID."）
5. `encodeFetchObjectFields` の delta 計算式は Ascending 時と Descending 時で共通（`|current - prior| - 1`）であるため、groupOrder パラメータは decode 側で主に使用する。PBT ラウンドトリップのために encode 側も groupOrder を受け取る
6. Group ID の範囲検証（0 以上 2^64-1 以下）は Ascending/Descending 両方に追加する（仕様上の MUST 要件）。0243 と実装範囲が重なるため、0243 を先に対応するか、本 issue 内で合わせて対応する

## 完了条件

- `FetcherImpl` が FETCH_OK から Group Order を保持し、`processFetchObjects` に伝搬すること
- `decodeFetchObjectFields` が Descending Group Order に対応し、正しい Group ID を解決すること
- `encodeFetchObjectFields` が groupOrder を受け取り、PBT で Descending ラウンドトリップが成功すること
- 関連するテスト (`dataStream.test.ts`) が更新され、`dataStream.prop.ts` に Descending の PBT が追加されていること
- 既存のテストがすべて通過すること

## 解決方法

### Step 1: `FetcherImpl` に groupOrder フィールドを追加

- `src/fetcher.ts`: `FetcherImpl` に `private groupOrder: number = GroupOrder.ASCENDING` を追加
- `src/session/bidi.ts`: `bidiReadFetchResponse` で FETCH_OK の parameters から GROUP_ORDER (0x22) を抽出し、`setFetchOkInfo` に渡す
- `src/fetcher.ts:105`: `setFetchOkInfo` のシグネチャに `groupOrder?: number` を追加

### Step 2: コールチェーンに groupOrder を伝搬

- `src/session/stream.ts`: `processFetchObjects` のシグネチャに `groupOrder: number` を追加
- `src/session.ts`: 受信ループ内の `processFetchObjects` 呼び出しで、`FetcherImpl` から groupOrder を取得して渡す

### Step 3: decode/encode に groupOrder を追加

- `src/dataStream.ts` `decodeFetchObjectFields`: `groupOrder: number` パラメータを追加。Descending 時は `groupId = context.groupId - delta - 1n`
- `src/dataStream.ts` `encodeFetchObjectFields`: `groupOrder?: number` パラメータを追加（PBT 用、デフォルトは Ascending）。Descending 時はエンコード側で delta の符号を反転

### Step 4: 検証とテスト

- Group ID が 0 未満または 2^64-1 超過時に `ProtocolViolationError` を throw する検証を追加
- `src/dataStream.test.ts` の全 `decodeFetchObjectFields` 呼び出しに `groupOrder` を追加
- `src/dataStream.prop.ts` を新規作成し、Ascending/Descending 両方のラウンドトリップ PBT を追加
- `src/session/stream.test.ts` の `processFetchObjects` テストがあれば更新
