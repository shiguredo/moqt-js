# fill の統計計上区分を購読配送と区別する

- Created: 2026-09-05
- Completed: {YYYY-MM-DD}
- Branch: feature/update-fill-stats-classification
- Polished: {YYYY-MM-DD}

## 目的

fill fetch ストリーム経由のオブジェクトが FETCH ストリーム到着として fetch 側統計に計上されており、購読配送と区別できない。fillDelivered 導入後の受信経路分離に合わせて統計分類も整理する。

## 現状

- incomingProcessFetchObjects (`src/session/incoming.ts`) は fill fetch ストリームのオブジェクトも fetch 側統計に計上する。
- ソースコードに「購読配送との区別は別途整理する」という残課題の注記がある。
- SessionImpl の統計 (`src/session.ts` の statsObjectsReceivedViaFetch 等) には fill 専用の区分が無い。

## 設計方針

- 受信経路の区別 (fillDelivered) と統計の区別を一致させる。
- fill を独立区分にするか購読側に寄せるかは、統計の利用目的 (デバッグ / moqmetrics 出力) に合わせて決める。
- 通常 FETCH の計上は変えない。

## 完了条件

- fill 経由と通常 FETCH / 購読経由の計上が区別されるテストがあること。
- `CHANGES.md` の `## develop` に `[UPDATE]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-20 §5.1.2 (Location Filters: subscription-delivered / fill-delivered)
- draft-ietf-moq-transport-20 §5.1.3 (Fill Semantics)
- 関連: fill と subscription の受信経路分離 (fillDelivered 導入) の後続課題
