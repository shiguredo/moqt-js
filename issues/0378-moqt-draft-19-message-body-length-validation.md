# 制御メッセージの Body 長一致検証が欠落している

- Priority: Medium
- Created: 2026-08-06
- Completed: {YYYY-MM-DD}
- Model: DeepSeek V4 Flash
- Branch: feature/fix-moqt-draft-19-message-body-length-validation
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-transport-19 §10 冒頭の「If the length does not match the length of the Message Body, the receiver MUST close the session with a PROTOCOL_VIOLATION.」を全メッセージで満たす。現在は GOAWAY / REQUEST_ERROR のみ trailing data 検証が実装されており、他のデコーダは Message Body を過不足なく消費したかを検証しない。

## 優先度根拠

Length フィールドで切り出した Body に余剰バイトを載せた不正メッセージを黙って受理する。ControlStreamReader が Length で payload を切り出すため framing 自体は整合するが、デコード結果が Body を過不足なく消費したことの検証がなく、仕様の MUST 要件を満たしていない。Medium。

## 現状

- trailing data 検証は GOAWAY (`src/message/session.ts:242-250`) と REQUEST_ERROR (`src/message/session.ts:402-409`) のみ実装。
- SUBSCRIBE (`src/message/subscribe.ts:70-99`)、REQUEST_UPDATE (`src/message/subscribe.ts:202-219`)、TRACK_STATUS (`src/message/trackstatus.ts:89-97`)、PUBLISH_NAMESPACE / SUBSCRIBE_NAMESPACE / SUBSCRIBE_TRACKS / NAMESPACE / NAMESPACE_DONE / PUBLISH_SKIPPED (`src/message/namespace.ts` 各 decode)、FETCH (`src/message/fetch.ts:116-167`)、PUBLISH_DONE (`src/message/publish.ts:168-190`) は消費バイト数と `data.length` の一致を検証していない。

## 設計方針

- 各デコーダの戻り値に consumed バイト数を追加するか、既存のデコーダが消費したオフセットが `data.length` と一致することを検証する共通ヘルパーを導入する。
- GOAWAY / REQUEST_ERROR の既存実装 (trailing data 検出パターン) に合わせる。
- テストは固定バイト列で余剰バイトを付加したケースを検証する。

## 完了条件

- 全制御メッセージのデコーダで、Body 長とデコード消費バイト数が一致しない場合に PROTOCOL_VIOLATION になること。
- 余剰バイト付きメッセージを検証するテストがあること。
- `CHANGES.md` の `## develop` に `[FIX]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-19 §10 (Control Messages 冒頭の Body 長一致要件)

## 解決方法

未着手。
