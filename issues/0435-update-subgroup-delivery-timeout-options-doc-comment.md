# PublishOptions / SubscribeOptions の subgroupDeliveryTimeout doc コメントを実態に合わせて修正する

- Created: 2026-08-28
- Updated: 2026-09-05
- Completed: {YYYY-MM-DD}
- Branch: feature/update-subgroup-delivery-timeout-options-doc-comment
- Polished: {YYYY-MM-DD}

## 目的

`PublishOptions.subgroupDeliveryTimeout` と `SubscribeOptions.subgroupDeliveryTimeout` (`src/session.ts`) の doc コメントに、moqt-js が値の比較・強制を行わない旨の記述が無い。0395 で `deliveryTimeout` (OBJECT_DELIVERY_TIMEOUT) は「moqt-js はこの値を … として送信するが、この値の強制は行わない」の対称構造に統一済みだが、直後に定義されている同種のパラメータ `subgroupDeliveryTimeout` (SUBGROUP_DELIVERY_TIMEOUT) は「Subgroup 内のオブジェクトを配信する最大時間。0 はタイムアウトなしを意味する。」だけの記述で、moqt-js が強制するかのように読める。draft-ietf-moq-transport-20 §8 は OBJECT_DELIVERY_TIMEOUT と SUBGROUP_DELIVERY_TIMEOUT を同じ枠組みで規定しており、両者の doc コメントを揃える必要がある。

## 現状

- `src/session.ts` の `PublishOptions.subgroupDeliveryTimeout` の doc コメントは draft-ietf-moq-transport-20 Section 12.1 を参照する 2 行 (「Subgroup 内のオブジェクトを配信する最大時間。」「0 はタイムアウトなしを意味する。」) のみ。moqt-js が SUBGROUP_DELIVERY_TIMEOUT を強制するかどうかに触れていない。
- `src/session.ts` の `SubscribeOptions.subgroupDeliveryTimeout` の doc コメントは draft-ietf-moq-transport-20 Section 10.2.3 を参照する同内容 2 行のみ。同上。
- 0395 の修正で `PublishOptions.deliveryTimeout` と `SubscribeOptions.deliveryTimeout` は「moqt-js はこの値を … として送信するが、この値の強制は行わない。比較と強制は Publisher 値と Subscriber 値の両方を持つエンドポイント（典型的にはリレー）の責務であり、詳細は Section 8 (Delivery Timeouts and Data Reliability) を参照。」の対称構造に統一済み。
- moqt-js は現状 SUBGROUP_DELIVERY_TIMEOUT の強制 (§8 のタイマー開始・ストリームリセット) を実装していない (0366 で扱う予定だが pending)。

## 設計方針

- `PublishOptions.subgroupDeliveryTimeout` と `SubscribeOptions.subgroupDeliveryTimeout` の doc コメントを、0395 で採用した「moqt-js はこの値を … として送信するが、この値の強制は行わない。比較と強制は Publisher 値と Subscriber 値の両方を持つエンドポイント（典型的にはリレー）の責務であり、詳細は Section 8 (Delivery Timeouts and Data Reliability) を参照。」の対称構造で書き直す。
- Publisher 側は「PUBLISH の Track Properties として送信」、Subscriber 側は「SUBSCRIBE の Message Parameter として送信」を各々のロールに合わせて明記する。
- 「0 はタイムアウトなしを意味する。」の記述は保持する (§8 で明記されている挙動)。
- 過度に長くしないため、詳細は Section 8 参照に委ね、両側の記述レベルを揃える (0395 の対称化と同じ方針)。

## 完了条件

- `PublishOptions.subgroupDeliveryTimeout` の doc コメントが 0395 の対称構造で書き直されており、moqt-js が比較・強制を行わない旨と Section 8 参照を含むこと。
- `SubscribeOptions.subgroupDeliveryTimeout` の doc コメントが同上。
- 「0 はタイムアウトなしを意味する」の記述が保持されていること。
- `CHANGES.md` の `## develop` の `### misc` サブセクションに `[UPDATE]` エントリが追加されていること (`shiguredo-changelog` 規約に従う)。
- `vp check` / `tsc --noEmit` / `vp test run` が通る。

## 参照

- draft-ietf-moq-transport-20 §8 (Delivery Timeouts and Data Reliability)
- draft-ietf-moq-transport-20 §10.2.3 (SUBGROUP_DELIVERY_TIMEOUT Parameter)
- draft-ietf-moq-transport-20 §12.1 (SUBGROUP_DELIVERY_TIMEOUT Property)
- 関連: `issues/closed/0395-fix-delivery-timeout-options-doc-comment.md` (`deliveryTimeout` の doc 修正。本 issue はその subgroup 版)
- 関連: `issues/pending/0366-add-delivery-timeout-enforcement.md` (Delivery Timeout の強制実装。実装後は「強制しない」記述の見直しが必要)

## 解決方法

未着手。
