# Stream Reset エラーコードを全リクエストストリームに一般化する

- Priority: Medium
- Created: 2026-05-13
- Model: Opus 4.7
- Polished: 2026-06-02

## 目的

draft-18 §3.3.3 で Stream Reset エラーコードが全リクエストストリーム向けに再編成された。DataStreamErrorCode と PublishDoneCode が仕様に準拠していることを確認する。

## 優先度根拠

- 既存コードの値は draft-18 と一致しているように見えるため、確認作業が主
- 不一致があれば修正が必要だが、現状のコードコメントも draft-18 を参照している

## 現状

`src/error.ts:100-111` の `DataStreamErrorCode` は既に以下を含む:
INTERNAL_ERROR(0x0), CANCELLED(0x1), DELIVERY_TIMEOUT(0x2), SESSION_CLOSED(0x3), GOING_AWAY(0x4), TOO_FAR_BEHIND(0x5), UNKNOWN_OBJECT_STATUS(0x6), EXPIRED_AUTH_TOKEN(0x7), EXCESSIVE_LOAD(0x9), MALFORMED_TRACK(0x12)

`src/error.ts:75-86` の `PublishDoneCode` は既に以下を含む:
INTERNAL_ERROR(0x0), UNAUTHORIZED(0x1), TRACK_ENDED(0x2), SUBSCRIPTION_ENDED(0x3), GOING_AWAY(0x4), TOO_FAR_BEHIND(0x5), EXPIRED(0x6), UPDATE_FAILED(0x8), EXCESSIVE_LOAD(0x9), MALFORMED_TRACK(0x12)

## 設計方針

- `DataStreamErrorCode` と `PublishDoneCode` の値が draft-18 §3.3.3 / §10.11 と完全に一致することを確認する
- 不一致があれば修正し、未定義のコードがあれば追加する
- 既に一致している場合はコメントを更新して確認済みであることを明記する

## 完了条件

- `DataStreamErrorCode` が draft-18 §3.3.3 の全コードと一致している
- `PublishDoneCode` が draft-18 §10.11 の全コードと一致している
- Stream reset 使用箇所で誤ったコードが使われていない

## 変更内容（確認項目）

| 確認項目 | 確認先 | 状態 |
|----------|--------|------|
| INTERNAL_ERROR (0x0) | DataStreamErrorCode, PublishDoneCode | 既存で存在 |
| CANCELLED (0x1) | DataStreamErrorCode | 既存で存在 |
| DELIVERY_TIMEOUT (0x2) | DataStreamErrorCode | 既存で存在 |
| SESSION_CLOSED (0x3) | DataStreamErrorCode | 既存で存在 |
| GOING_AWAY (0x4) | DataStreamErrorCode, PublishDoneCode | 既存で存在 |
| TOO_FAR_BEHIND (0x5) | DataStreamErrorCode, PublishDoneCode | 既存で存在 |
| UNKNOWN_OBJECT_STATUS (0x6) | DataStreamErrorCode | 既存で存在 |
| EXPIRED_AUTH_TOKEN (0x7) | DataStreamErrorCode | 既存で存在 |
| EXCESSIVE_LOAD (0x9) | DataStreamErrorCode, PublishDoneCode | 既存で存在 |
| MALFORMED_TRACK (0x12) | DataStreamErrorCode, PublishDoneCode | 既存で存在 |
| UNAUTHORIZED (0x1) | PublishDoneCode | 既存で存在 |
| TRACK_ENDED (0x2) | PublishDoneCode | 既存で存在 |
| SUBSCRIPTION_ENDED (0x3) | PublishDoneCode | 既存で存在 |
| EXPIRED (0x6) | PublishDoneCode | 既存で存在 |
| UPDATE_FAILED (0x8) | PublishDoneCode | 既存で存在 |

## 影響範囲

- コメントと値の確認が主。不一致がなければコード変更不要
- 不一致があった場合、エラーコードの数値変更は既存のストリーム処理に影響（後方互換なし）
