# GOAWAY メッセージに Request ID フィールドを追加する

- Priority: High
- Created: 2026-05-13
- Model: Opus 4.7
- Polished: 2026-06-02

## 目的

draft-18 で GOAWAY メッセージに Request ID フィールドが追加された。制御ストリーム上の GOAWAY は処理済みリクエストの境界を示す Request ID を含む。リクエストストリーム上の GOAWAY には Request ID は含まれない。

## 優先度根拠

- draft-18 準拠のための必須変更
- ワイヤーフォーマットが変わる破壊的変更
- 0187 (リクエストストリーム GOAWAY) の前提となる依存関係

## 現状

現在の `Goaway` インターフェース (`src/message/session.ts:33-41`) は `newSessionUri` / `timeout` のみで Request ID フィールドがない。
`encodeGoawayPayload` / `decodeGoawayPayload` も Timeout までで固定長として処理している。
`sendGoaway()` はクライアント専用として空の New Session URI を送信しているが、Request ID の計算と送信は行っていない。

draft-ietf-moq-transport-18 §10.4:

> GOAWAY Message {
> Type (vi64) = 0x10,
> Length (16),
> New Session URI Length (vi64),
> New Session URI (..),
> Timeout (vi64),
> [Request ID (vi64)],
> }

> - Request ID: Present only when sent on the control stream. The
>   smallest peer Request ID that was not or might not have been
>   processed prior to sending the GOAWAY. If no requests have been
>   processed, this is 0 (at a server) or 1 (at a client). If the
>   parity of the Request ID does not match the receiver's parity, the
>   endpoint MUST close the session with INVALID_REQUEST_ID.

## 設計方針

- `Goaway` 型に `requestId: bigint | null` を追加。制御ストリーム上の GOAWAY は Request ID を含み、リクエストストリーム上の GOAWAY は null
- エンコード: `requestId` が非 null の場合、Timeout の後に Request ID (vi64) を追加でエンコードする
- デコード: Timeout のデコード後、残りバイトがあれば Request ID をデコードする。制御ストリームで残りバイトがない場合は ProtocolViolationError
- クライアントは制御ストリーム上で GOAWAY を送信するため、`requestId` として「次に割り当てるべき Request ID」（= 最後に割り当てた偶数 ID + 2）を送信する
- 制御ストリーム受信時の Request ID パリティ検証: 受信側パリティと一致しなければ `INVALID_REQUEST_ID` でセッションを閉じる
- リクエストストリーム受信時: Request ID フィールドは存在しないため decode しない。0187 がこの挙動に依存する

## 完了条件

- `Goaway` 型に `requestId: bigint | null` が追加されている
- `encodeGoawayPayload` が条件付き Request ID エンコードに対応している
- `decodeGoawayPayload` が残りバイトからの条件付き Request ID デコードに対応している
- クライアントの `sendGoaway()` が正しい Request ID を計算して送信している
- 制御ストリーム上の GOAWAY 受信時に Request ID パリティが検証される
- PBT で requestId あり / なし両方のラウンドトリップが成功する

## 変更内容

### 1. Goaway 型とエンコード/デコードの更新 (`src/message/session.ts`)

- `Goaway` インターフェースに `requestId: bigint | null` を追加
  - 制御ストリーム上: 処理済みリクエストの境界を示す Request ID
  - リクエストストリーム上: `null`（Request ID は存在しない）
- `encodeGoawayPayload`:
  - `requestId` が非 null の場合、Timeout の後に `encodeVarint(msg.requestId)` を追加
- `decodeGoawayPayload`:
  - New Session URI Length + New Session URI + Timeout をデコード後、残りバイトがあれば `decodeVarint` で Request ID をデコード
  - 残りバイトがなければ `requestId = null`

### 2. GOAWAY 送信処理の更新 (`src/session.ts`)

- `sendGoaway()`: クライアントとして制御ストリーム上で GOAWAY を送信する際、`requestId` に次の割り当て番号（`nextRequestId`）を設定する
  - クライアントは偶数 ID (0, 2, 4, ...) を使用。最初のリクエスト未発行なら requestId = 0
- 空でない New Session URI の送信禁止は既存ルールを維持（クライアントは常に空）

### 3. GOAWAY 受信処理の更新 (`src/session.ts`)

- `handleGoaway()`: 制御ストリーム上の GOAWAY 受信時に以下を検証:
  - `requestId` が存在すること（null なら ProtocolViolationError）
  - `requestId` のパリティが受信側と一致すること（違反時は INVALID_REQUEST_ID でセッションを閉じる）
- 0187 完了後、リクエストストリーム上の GOAWAY 受信時は `requestId` が null である前提で処理する

## 該当箇所一覧

| ファイル                         | 変更内容                                                           |
| -------------------------------- | ------------------------------------------------------------------ |
| `src/message/session.ts:33-41`   | `Goaway` 型に `requestId: bigint \| null` を追加                   |
| `src/message/session.ts:96-112`  | `encodeGoawayPayload` に条件付き Request ID エンコードを追加       |
| `src/message/session.ts:117-140` | `decodeGoawayPayload` に残りバイトからの Request ID デコードを追加 |
| `src/session.ts:725-780`         | `sendGoaway()`: requestId の計算と送信を追加                       |
| `src/session.ts:3009-3045`       | `handleGoaway()`: Request ID の存在確認とパリティ検証を追加        |

## テスト方針

### PBT の追加 (`src/message/session.prop.ts`)

- `requestId` が存在する GOAWAY（制御ストリーム想定）のエンコード/デコード ラウンドトリップ
- `requestId = null` の GOAWAY（リクエストストリーム想定）のエンコード/デコード ラウンドトリップ
  - エンコード時に Request ID が出力されないことの検証
- Request ID パリティ不一致時の `ProtocolViolationError` 検証

### 単体テストの更新

- 既存の GOAWAY テストが `requestId` 追加後も正しく動作することを確認

## 影響範囲

- GOAWAY のワイヤーフォーマットが変わる（後方互換なし）
- `Goaway` 型に `requestId` フィールドが追加される（後方互換あり、null 許容）
- 制御ストリーム上の GOAWAY 受信時にパリティ検証が追加される（これまでエラーにならなかったケースが INVALID_REQUEST_ID になる可能性）

## 関連 issue

- 0187: リクエストストリーム上の GOAWAY 受信ハンドリング（0188 が GOAWAY に Request ID を追加し、0187 がリクエストストリーム上で null になる前提で受信する）
