# Subscription Parameters を PUBLISH_OK から外し REQUEST_UPDATE 側に揃える

- Created: 2026-09-01
- Completed: {YYYY-MM-DD}
- Branch: feature/change-move-subscription-params-off-publish-ok
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-transport-20 では Subscription Parameters (LOCATION_FILTER / FORWARD / timeouts / SUBSCRIBER_PRIORITY / NEW_GROUP_REQUEST 等) は PUBLISH_OK ではなく REQUEST_UPDATE に載る。受信スコープを draft-20 に合わせて PROTOCOL_VIOLATION 誤検知と過剰許容を解消する。

## 現状

- `PUBLISH_OK_ALLOWED_PARAMS` (`src/message/parameterScope.ts`) は draft-19 のまま LOCATION_FILTER / FORWARD / OBJECT_DELIVERY_TIMEOUT / SUBGROUP_DELIVERY_TIMEOUT / SUBSCRIBER_PRIORITY / NEW_GROUP_REQUEST / EXPIRES / Range Filters を許可している。
- 送信経路 (`bidiReadPublishResponse` 周辺) は空の Parameters を送ることが多いが、受信許容が広い。
- open issue `0436` / `0437` 等は PUBLISH_OK + LOCATION_FILTER 前提のため、本変更後に前提を更新する必要がある (本 issue 内で追随するか、実装時に当該 issue を更新する)。

## 設計方針

- draft-20 の各パラメータ定義と §10.2.1 Parameter Scope に従い、`PUBLISH_OK_ALLOWED_PARAMS` から Subscription Parameters を外す。PUBLISH_OK に残るものだけを残す (仕様照合のうえ確定)。
- Subscription Parameters の更新は既存の REQUEST_UPDATE 経路 (`REQUEST_UPDATE_ALLOWED_PARAMS`) に寄せる。不足があれば REQUEST_UPDATE 側を拡張する。
- 関連 open issue (0436 等) の本文前提を draft-20 向けに更新する。

## 完了条件

- `PUBLISH_OK_ALLOWED_PARAMS` が draft-20 の許可集合と一致すること。
- PUBLISH_OK に禁止パラメータが来た場合 PROTOCOL_VIOLATION になるテストがあること。
- REQUEST_UPDATE で必要な Subscription Parameters が引き続き送受信できること。
- `CHANGES.md` の `## develop` に `[UPDATE]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-20 §10.2.1 (Parameter Scope)
- draft-ietf-moq-transport-20 §10.2.3–10.2.4 / §10.2.7 / §10.2.9 / §10.2.18–10.2.19
- draft-ietf-moq-transport-20 Appendix A.1 (#1790)
- 関連: `issues/0436-bug-publish-ok-location-filter-validation.md`
- 関連: `issues/0437-bug-request-update-raw-location-filter-bypass.md`
