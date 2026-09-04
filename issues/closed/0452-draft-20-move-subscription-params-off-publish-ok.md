# Subscription Parameters を PUBLISH_OK から外し REQUEST_UPDATE 側に揃える

- Created: 2026-09-01
- Completed: 2026-09-04
- Branch: feature/change-move-subscription-params-off-publish-ok
- Polished: 2026-09-02

## 目的

draft-ietf-moq-transport-20 では Subscription Parameters (LOCATION_FILTER / FORWARD / timeouts / SUBSCRIBER_PRIORITY / NEW_GROUP_REQUEST 等) は PUBLISH_OK ではなく REQUEST_UPDATE に載る。受信スコープを draft-20 に合わせて PROTOCOL_VIOLATION 誤検知と過剰許容を解消する。

## 現状

- `PUBLISH_OK_ALLOWED_PARAMS` (`src/message/parameterScope.ts`) は draft-19 のまま LOCATION_FILTER / FORWARD / OBJECT_DELIVERY_TIMEOUT / SUBGROUP_DELIVERY_TIMEOUT / SUBSCRIBER_PRIORITY / NEW_GROUP_REQUEST / EXPIRES / Range Filters を許可している。
- 送信経路 (`handleIncomingBidirectionalStream` の PUBLISH_OK 応答) は空の Parameters を送ることが多いが、受信許容が広い。
- open issue `0436` は PUBLISH_OK 受信で LOCATION_FILTER の値を検証する前提のため、本変更後に前提を更新する (0436 本文の注記も本 issue を参照済み)。`0437` は REQUEST_UPDATE 送信側の raw パラメータ経路が主題であり、draft-20 でも REQUEST_UPDATE に LOCATION_FILTER は出現可能なため本変更の影響を受けない。

## 設計方針

- draft-20 の各パラメータ定義と §10.2.1 Parameter Scope に従い、`PUBLISH_OK_ALLOWED_PARAMS` から Subscription Parameters を外し、PUBLISH_OK に MAY appear する EXPIRES (§10.2.16) のみを残す。
- Subscription Parameters の更新は既存の REQUEST_UPDATE 経路 (`REQUEST_UPDATE_ALLOWED_PARAMS`) に寄せる。PUBLISH_OK から移すパラメータは既に同集合に含まれており拡張は不要。新規の `FILL_PARAMETERS` (0x23) は 0450 の範囲であり本 issue では扱わない。
- 関連 open issue (0436 等) の本文前提を draft-20 向けに更新する。

## 完了条件

- `PUBLISH_OK_ALLOWED_PARAMS` が draft-20 の許可集合 ({EXPIRES}) と一致すること。
- PUBLISH_OK に禁止パラメータが来た場合 PROTOCOL_VIOLATION になるテストがあること。
- REQUEST_UPDATE で必要な Subscription Parameters が引き続き送受信できること。
- `CHANGES.md` の `## develop` に `[CHANGE]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-20 §10.2.1 (Parameter Scope)
- draft-ietf-moq-transport-20 §10.2.3–10.2.4 / §10.2.7 / §10.2.9 / §10.2.16 / §10.2.18–10.2.19
- draft-ietf-moq-transport-20 Appendix A.1 (#1790)
- 関連: `issues/0436-bug-publish-ok-location-filter-validation.md`
- 関連: `issues/0437-bug-request-update-raw-location-filter-bypass.md`

## 解決方法

`PUBLISH_OK_ALLOWED_PARAMS` を EXPIRES のみに縮小し、受信経路を draft-20 に揃えた。

- PUBLISH_OK での Range Filter / LOCATION_FILTER 値検証と Forward State 反映をやめ、許可外はスコープ違反として PROTOCOL_VIOLATION で閉じる
- スコープ違反時も保留中の発行を残さないよう、削除・reject・close の順序を Track Properties 違反と揃えた
- Subscription Parameters の送受信は REQUEST_UPDATE 経路に寄せ、同集合の拡張は行わない
- 関連 issue のうち 0436 は closed のため本文更新は不要であり、0437 は REQUEST_UPDATE 経路のため影響を受けない
- `CHANGES.md` の `## develop` に `[CHANGE]` を追記する
