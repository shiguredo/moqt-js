# README / docs の実装状況と API 記述を draft-19 実装に合わせて修正する

- Priority: Medium
- Created: 2026-08-06
- Completed: {YYYY-MM-DD}
- Model: DeepSeek V4 Flash
- Branch: feature/doc-moqt-draft-19-implementation-status
- Polished: {YYYY-MM-DD}

## 目的

README.md の実装状況と docs/LOW_LEVEL_API.md の API 記述を、draft-19 対応済みの実装実態に合わせて修正する。GOAWAY の Request ID は draft-19 で削除済みだが README には「Request ID 対応」と残っており、LOW_LEVEL_API.md には draft-18 で廃止された旧引数名が残っている。

## 優先度根拠

README は実装状況の一次情報源であり、draft-19 で削除された機能を「対応済み」と記載すると利用者を誤誘導する。Medium。

## 現状

- `README.md:118` — GOAWAY の項目に「Request ID 対応」と記載。draft-19 (§10.4) で Request ID は削除済みで、コード (`src/message/session.ts`) にも requestId は存在しない。
- `docs/LOW_LEVEL_API.md:74` — `subscribeNamespace(namespacePrefix, callbacks, mode?)` と記載。実装の第 3 引数は `options?: { authorizationToken?: AuthorizationToken }` (`src/session.ts:908-912`) であり、`mode` は draft-18 で廃止された旧引数名。
- `docs/LOW_LEVEL_API.md:214` — `readRequestStreamMessages()` と記載。実装は bidi.ts 内部の `bidiReadRequestStreamMessages` (非公開)。

## 設計方針

- README.md の GOAWAY 項目から「Request ID 対応」を削除し、draft-19 の実装状況 (Timeout / リクエストストリーム上での受信) に合わせる。
- docs/LOW_LEVEL_API.md の `subscribeNamespace` の引数記述を実装 (options) に合わせて修正する。
- docs/LOW_LEVEL_API.md の `readRequestStreamMessages` の記述を実装に合わせて修正または削除する。

## 完了条件

- README.md の実装状況がコード実装と一致すること。
- docs/LOW_LEVEL_API.md の API 記述が実装と一致すること。
- 他に実装状況と食い違う記述がないこと。

## 参照

- draft-ietf-moq-transport-19 §10.4 (GOAWAY)
- draft-ietf-moq-transport-19 §10.18 (SUBSCRIBE_NAMESPACE)

## 解決方法

未着手。
