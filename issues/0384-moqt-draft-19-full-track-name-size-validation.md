# SUBSCRIBE / FETCH / TRACK_STATUS デコードの Full Track Name 4096 バイト検証が欠落している

- Priority: Low
- Created: 2026-08-06
- Completed: {YYYY-MM-DD}
- Model: DeepSeek V4 Flash
- Branch: feature/fix-moqt-draft-19-full-track-name-size-validation
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-transport-19 §2.4.1 の「If an endpoint receives a Track Namespace or a Full Track Name exceeding 4,096 bytes, it MUST close the session with a PROTOCOL_VIOLATION.」を全メッセージで満たす。現在は `decodePublishPayload` のみ `validateFullTrackName` が呼ばれ、SUBSCRIBE / FETCH / TRACK_STATUS のデコーダでは Track Namespace + Track Name の合計サイズが検証されない。

## 優先度根拠

§2.4.1 の MUST 要件の適用漏れ。Track Namespace 単体の 4,096 バイト検証は `decodeTrackNamespace` で全メッセージ共通に実施済みだが、Full Track Name (Namespace + Name) の合計検証が SUBSCRIBE / FETCH / TRACK_STATUS にない。Low。

## 現状

- `validateFullTrackName` は `src/message/publish.ts:106-109` (`decodePublishPayload`) のみで呼ばれる。
- `decodeSubscribePayload` (`src/message/subscribe.ts`)、`decodeTrackStatusPayload` (`src/message/trackstatus.ts`)、`decodeFetchPayload` (`src/message/fetch.ts`) は Track Name 長を含む Full Track Name 合計の検証がない。

## 設計方針

- `decodeSubscribePayload` / `decodeTrackStatusPayload` / `decodeFetchPayload` に `validateFullTrackName` 相当の検証 (Track Namespace サイズ + Track Name サイズの合計が 4,096 バイト以下) を追加する。
- 超過時は ProtocolViolationError を送出する。
- 固定バイト列で 4,096 バイト超過ケースを検証するテストを追加する。

## 完了条件

- SUBSCRIBE / FETCH / TRACK_STATUS で Full Track Name が 4,096 バイトを超える場合に PROTOCOL_VIOLATION になること。
- 上記を検証する固定バイト列テストがあること。
- `CHANGES.md` の `## develop` に `[FIX]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-19 §2.4.1 (Track Naming)

## 解決方法

未着手。
