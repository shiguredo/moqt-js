# 受信 PUBLISH で Subscription Parameters を許可する

- Created: 2026-09-01
- Completed: 2026-09-04
- Branch: feature/update-allow-subscription-params-on-publish
- Polished: 2026-09-02

## 目的

draft-ietf-moq-transport-20 §10.11 / §10.20.1 では PUBLISH が Subscription Parameters (FORWARD / GROUP_ORDER / SUBSCRIBER_PRIORITY / timeouts / LOCATION_FILTER 等) を運べる。受信スコープを広げ、正当な PUBLISH が PROTOCOL_VIOLATION にならないようにする。

## 現状

- `PUBLISH_ALLOWED_PARAMS` (`src/message/parameterScope.ts`) は AUTHORIZATION_TOKEN / EXPIRES / LARGEST_OBJECT / FORWARD / GROUP_ORDER のみ。
- draft-20 では SUBSCRIBE_TRACKS の結果 PUBLISH に publisher の初期 Subscription Parameters が明示され (§10.20.1)、AUTHORIZATION_TOKEN は SUBSCRIBE_TRACKS からコピーされない (A.1 #1834)。
- 追加パラメータを含む PUBLISH は現状 `validateParameterScope` で PROTOCOL_VIOLATION になる。
- moqt-js は SUBSCRIBE_TRACKS 受信を NOT_SUPPORTED としているため、AUTH 非コピーの送信側ロジックは対象外。受信 PUBLISH のスコープ拡大が本 issue の範囲。

## 設計方針

- draft-20 §10.11 と各パラメータ定義を照合し、`PUBLISH_ALLOWED_PARAMS` を更新する。
- 受信 PUBLISH 処理 (`handleIncomingBidirectionalStream`) で新たに許可したパラメータのうち、subscription の状態に関わる LOCATION_FILTER は `SubscriberImpl.setLocationFilter` に反映する。OBJECT_DELIVERY_TIMEOUT / SUBGROUP_DELIVERY_TIMEOUT / SUBSCRIBER_PRIORITY は publisher の初期値の通知であり状態反映はしない (受理のみ)。FORWARD は従来どおり Forward State に反映する。
- 0452 (PUBLISH_OK から外す) と独立して進められるが、スコープ集合の意図が食い違わないよう両方の完了後に相互照合する。

## 完了条件

- `PUBLISH_ALLOWED_PARAMS` が draft-20 の許可集合と一致すること (既存 5 種 + OBJECT_DELIVERY_TIMEOUT / SUBGROUP_DELIVERY_TIMEOUT / SUBSCRIBER_PRIORITY / LOCATION_FILTER の 4 種追加。NEW_GROUP_REQUEST / Range Filters / FILL_PARAMETERS は含めない)。
- draft-20 で許可される Subscription Parameters 付き PUBLISH を PROTOCOL_VIOLATION にせず受信できるテストがあること。
- 受信 PUBLISH の LOCATION_FILTER が subscriber の Location Filter に反映されるテストがあること。
- `CHANGES.md` の `## develop` に `[UPDATE]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-20 §10.11 (PUBLISH)
- draft-ietf-moq-transport-20 §10.20.1 (Parameters on SUBSCRIBE_TRACKS)
- draft-ietf-moq-transport-20 Appendix A.1 (#1834, #1815, #1869)
- 関連: `issues/0452-draft-20-move-subscription-params-off-publish-ok.md`

## 解決方法

`PUBLISH_ALLOWED_PARAMS` を既存 5 種から 9 種に拡大し、受信経路を draft-20 に揃えた。

- OBJECT_DELIVERY_TIMEOUT / SUBGROUP_DELIVERY_TIMEOUT / SUBSCRIBER_PRIORITY / LOCATION_FILTER を追加し、NEW_GROUP_REQUEST / Range Filters / FILL_PARAMETERS は引き続き拒否する
- 受信 PUBLISH の LOCATION_FILTER を初期フィルタとして反映し、FORWARD 値域外と End Group 超過はセッションを閉じる
- 0452 と相互照合し、PUBLISH 許可と PUBLISH_OK 拒否に矛盾がないことを確認する
- `CHANGES.md` の `## develop` に `[UPDATE]` を追記する
