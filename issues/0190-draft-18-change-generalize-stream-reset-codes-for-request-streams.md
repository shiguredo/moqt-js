# Stream Reset エラーコードを全リクエストストリームに一般化する

Created: 2026-05-13
Model: Opus 4.7

## 概要

draft-18 で Stream Reset エラーコードが再編成され、全リクエストストリームに対して統一されたコード体系が導入された。
draft-17 での DataStreamErrorCode (Subgroup Stream 用のエラーコード) が拡張・再構成されている。

> An endpoint MUST NOT send any of these error codes on a stream where
> they are not applicable.  An endpoint that receives a stream error
> code where it is not applicable SHOULD close the session with a
> PROTOCOL_VIOLATION.
>
> -- draft-ietf-moq-transport-18 §3.3.3

> Publish Done Status Code:
>   0x0: UNSUBSCRIBED
>   0x1: INTERNAL_ERROR
>   0x2: UNAUTHORIZED
>   0x3: TRACK_ENDED
>   0x4: PUBLICATION_ENDED
>   0x5: TOO_FAR_BEHIND
>   0x6: EXCESSIVE_LOAD
>
> -- draft-ietf-moq-transport-18 §10.11

## 変更内容

### 1. DataStreamErrorCode を更新する (`src/error.ts`)

- draft-18 §3.3.3 の新しいエラーコード体系に合わせて `DataStreamErrorCode` を更新する
- 新規追加されたコードがあれば追加する
- PUBLISH_DONE の Status Code と STREAM_RESET の Error Code を分離する
  - PUBLISH_DONE Status Code は `PublishDoneStatusCode` enum に保持する
  - Stream Reset Error Code は `StreamResetErrorCode` enum を新設する（または `DataStreamErrorCode` を更新）

### 2. RESET_STREAM / STOP_SENDING ハンドリングを更新する (`src/session.ts`)

- `handleIncomingStream` でのリセット受信時に新しいコードを正しく解釈する
- `cancelStreamQuiet` での STOP_SENDING 送信時に正しいコードを使用する
- 全リクエストストリーム (SUBSCRIBE/FETCH/PUBLISH/NAMESPACE 等) で統一されたコード体系を使用する

### 3. PUBLISH_DONE のステータスコードマッピングを確認する

- `PublishDoneStatusCode` が draft-18 §10.11 のコードと一致していることを確認する
- 新規追加コード (`TOO_FAR_BEHIND`, `EXCESSIVE_LOAD`) が存在することを確認する

## 該当箇所

| ファイル | 変更内容 |
|---|---|
| `src/error.ts:17-35` | `DataStreamErrorCode` を draft-18 の Stream Reset Error Codes に更新する |
| `src/error.ts:96-115` | `PublishDoneStatusCode` を draft-18 §10.11 と照合する |
| `src/session.ts` (handleIncomingStream) | ストリームリセット受信時のコードマッピングを更新する |
| `src/session/stream.ts` (cancelStreamQuiet) | STOP_SENDING 送信時のコードマッピングを更新する |

## テスト方針

- `src/error.test.ts`: 新しいエラーコード定数の値と対応する名称を検証する
- ストリームリセットのシミュレーションテストで新しいコードが正しくハンドリングされることを検証する

## 影響範囲

- `DataStreamErrorCode` の値が変更される可能性がある（後方互換なし）
- ストリームリセット受信時の挙動が新しいコード体系に合わせて更新される
