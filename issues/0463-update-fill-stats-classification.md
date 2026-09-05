# fill の統計計上区分を購読配送と区別する

- Created: 2026-09-05
- Completed: {YYYY-MM-DD}
- Branch: feature/update-fill-stats-classification
- Polished: {YYYY-MM-DD}
- Updated: 2026-09-05

## 目的

fill fetch ストリーム経由のオブジェクトが通常 FETCH と同じ fetch 側統計に計上されており、fill と通常 FETCH を区別できない。fillDelivered 導入後の受信経路分離に合わせて統計分類も整理する。

## 現状

- incomingProcessFetchObjects (`src/session/incoming.ts`) は fill fetch ストリームのオブジェクトも fetch 側統計に計上する。
- ソースコードに「購読配送との区別は別途整理する」という残課題の注記がある。
- SessionImpl の統計 (`src/session.ts` の statsObjectsReceivedViaFetch 等) には fill 専用の区分が無い。

## 設計方針

- 受信経路の区別 (fillDelivered) と統計の区別を一致させる。
- fill は仕様 (§5.1.2) 上 subscription-delivered とは別概念のため、原則として独立区分または fetch 側の内訳とする。購読側合算は採用しない。fill 範囲と subscription の Location Filter が重なる both の場合 (§5.1.3) の計上ルール (二重計上 / fill 優先 / 購読優先) も本 issue で定義する。
- 通常 FETCH の計上は変えない。

## 完了条件

- fill 経由と通常 FETCH / 購読経由の計上が区別されるテストがあること。
- `CHANGES.md` の `## develop` に `[UPDATE]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-20 §5.1.2 (Location Filters: subscription-delivered / fill-delivered)
- draft-ietf-moq-transport-20 §5.1.3 (Fill Semantics)
- 関連: `issues/closed/0459-draft-20-handle-fill-vs-subscription-delivery.md` の後続 (fillDelivered 導入済み。本 issue は統計分類を扱う)。並列の後続として `issues/0462-add-fill-failure-notification.md` (失敗通知) があり、スコープは重ならない
