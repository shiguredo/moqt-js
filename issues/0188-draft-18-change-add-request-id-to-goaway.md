# GOAWAY メッセージに Request ID フィールドを追加する

Created: 2026-05-13
Model: Opus 4.7

## 概要

draft-18 で GOAWAY メッセージに Request ID フィールドが追加された。
これにより、リクエストストリーム上の GOAWAY (0187) が特定のリクエストを識別できるようになる。
制御ストリーム上の GOAWAY は Request ID を含まない（ゼロ長）。

> GOAWAY Message {
>   Type (vi64) = 0x10,
>   Length (16),
>   Request ID Length (vi64),
>   Request ID (..),
>   New Session URI Length (vi64),
>   New Session URI (..),
>   Timeout (vi64),
> }
>
> -- draft-ietf-moq-transport-18 §10.4

> When sent on the control stream, the Request ID Length MUST be 0.
> When sent on a request stream, the Request ID MUST match the request
> that initiated the stream.
>
> -- draft-ietf-moq-transport-18 §10.4

## 変更内容

### 1. Goaway 型に requestId フィールドを追加する (`src/message/session.ts`)

- `Goaway` インターフェースに `requestId: bigint | null` を追加する
  - 制御ストリーム上の GOAWAY は `requestId = null`（Request ID Length = 0）
  - リクエストストリーム上の GOAWAY は `requestId` にリクエスト ID が入る
- `encodeGoawayPayload()` に Request ID Length + Request ID のエンコードを追加する
  - `requestId` が `null` の場合は Request ID Length = 0、Request ID フィールド省略
  - `requestId` が存在する場合は Request ID Length + Request ID (vi64) をエンコード
- `decodeGoawayPayload()` に Request ID Length + Request ID のデコードを追加する
  - Request ID Length = 0 の場合は `requestId = null`

### 2. GOAWAY 送受信箇所を更新する (`src/session.ts`)

- `SessionImpl.sendGoaway()` で制御ストリーム上の GOAWAY に `requestId: null` を指定する
- `decodeGoawayPayload()` の呼び出し結果から `requestId` を取得する
- リクエストストリーム上の GOAWAY 受信時 (0187) に `requestId` で該当リクエストを特定する

### 3. クライアント送信 GOAWAY の制約を更新する (`src/session.ts`)

- "client MUST send GOAWAY with empty New Session URI" のコメントを draft-18 版に更新する

## 該当箇所

| ファイル | 変更内容 |
|---|---|
| `src/message/session.ts:17-51` | `Goaway` 型に `requestId: bigint \| null` を追加する |
| `src/message/session.ts:80-128` | `encodeGoawayPayload` に Request ID エンコードを追加する |
| `src/message/session.ts:110-150` | `decodeGoawayPayload` に Request ID デコードを追加する |
| `src/session.ts:1900-1930` | `sendGoaway()` の GOAWAY 構築に `requestId: null` を追加する |
| `src/session.ts` (GOAWAY 受信箇所) | `requestId` を抽出してリクエスト特定に使用する |

## テスト方針

- `src/message/session.prop.ts`: `requestId: null`（制御ストリーム用）のエンコード/デコード PBT を追加する
- `src/message/session.prop.ts`: `requestId` が存在するケースのエンコード/デコード PBT を追加する
- 既存の GOAWAY テストが `requestId` 追加後も正しく動作することを確認する

## 影響範囲

- GOAWAY のワイヤーフォーマットが変わる（後方互換なし）
- `Goaway` 型に `requestId` フィールドが追加される（後方互換あり、null 許容）
- クライアント送信 GOAWAY は常に `requestId: null`（クライアントがリクエストストリーム上で GOAWAY を送信しないため）

## 関連 issue

- 0187: リクエストストリーム上の GOAWAY 受信ハンドリング（0188 が GOAWAY に Request ID を追加し、0187 がそれを利用する）
