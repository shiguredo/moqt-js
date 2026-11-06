# SUBSCRIBE_TRACKS の初期パラメータを draft 23 の明示一覧に揃える

- Created: 2026-11-03
- Completed: 2026-11-04
- Branch: feature/change-moqt-draft-23
- Polished: 2026-11-03

## 目的

draft 23 §3.6.2 / §9.17 は SUBSCRIBE_TRACKS の許可パラメータを明示し、timeout、priority、Location Filter、fill の指定を可能にした。現在の API は draft 22 の狭い一覧だけを構築するため、新しい初期購読条件を要求できない。

## 現状

- `src/session/params.ts` の `buildSubscribeTracksParameters` は GROUP_ORDER / FORWARD / Range Filters / AUTHORIZATION_TOKEN / INCLUDE_PROPERTIES を構築する
- `src/session/namespaces.ts` の `namespacesSubscribeTracks` は fill が無い前提で Range Filter 上限を数える
- 公開 options と既存コメントは §3.6.2 と §9.18 の旧不整合を説明している

## 設計方針

- §9.17 に従って OBJECT_DELIVERY_TIMEOUT、SUBGROUP_DELIVERY_TIMEOUT、SUBSCRIBER_PRIORITY、LOCATION_FILTER、FILL_PARAMETERS を公開 options と builder へ追加する
- PAUSED は 0896、FILL_PARAMETERS のワイヤは 0895 を使う。通常の SUBSCRIBE にしか意味の無い RENDEZVOUS_TIMEOUT / NEW_GROUP_REQUEST は追加しない
- 外側と fill 内側の Range Filter 合計を peer MAX_FILTER_RANGES に照合し、stream 生成前に拒否する
- AUTHORIZATION_TOKEN と TRACK_PROPERTY_FILTER は元の SUBSCRIBE_TRACKS 自体に適用する。結果 PUBLISH の処理は §9.8 の許可一覧と照合し、すべてのパラメータを無条件にコピーする relay を実装しない
- §3.6.2 は残りのパラメータを結果 PUBLISH に含めると書くが、§9.8 の明示一覧には Range Filters / INCLUDE_PROPERTIES が無く、本文間の不整合は残る。本 issue では受信 PUBLISH の許可集合をこの一般文だけで広げず、明示一覧を優先する。仕様の修正があれば実装前に再確認する
- 受信 PUBLISH の fill / origin ID の処理は 0908 / 0905 に委ねる

## 完了条件

- 新しい各初期条件を送信でき、未指定時の既定値を変えない
- 禁止される単一 Track 専用パラメータを送らない
- 外側 + fill 内側の範囲数の境界を検証する
- 公開 SubscribeTracksOptions / builder / 送信される Parameters / API 文書の一覧が一致する

## 参照

- `refs/moq/draft-ietf-moq-transport-23.txt` §3.6.2 / §9.17 / §9.19.3〜§9.19.15
- `src/session/publicTypes.ts` の `SubscribeTracksOptions`、`src/session/params.ts` の `buildSubscribeTracksParameters`
- `src/session/namespaces.ts` の `namespacesSubscribeTracks`

## 解決方法

- `src/session/publicTypes.ts` の `SubscribeTracksOptions` に LOCATION_FILTER (`filter`)、OBJECT_DELIVERY_TIMEOUT (`deliveryTimeout`)、SUBGROUP_DELIVERY_TIMEOUT (`subgroupDeliveryTimeout`)、SUBSCRIBER_PRIORITY (`subscriberPriority`)、FILL_PARAMETERS (`fill`) を追加した。§3.6.2 の扱い (AUTHORIZATION_TOKEN / TRACK_PROPERTY_FILTER は要求自体に適用し、それ以外は結果 PUBLISH の初期条件) と、RENDEZVOUS_TIMEOUT / NEW_GROUP_REQUEST を追加しない理由 (単一 Track 専用) を JSDoc に明記した。
- `src/session/params.ts` の `buildSubscribeTracksParameters` が上記に加え、既存の GROUP_ORDER / PAUSED / Range Filters / AUTHORIZATION_TOKEN / INCLUDE_PROPERTIES と合わせて §9.17 の明示一覧を構築するようにした。FILL_PARAMETERS のワイヤは count-prefixed の実装をそのまま使い、内側のパラメータは §9.19.15 の制限に従う。
- 未指定の項目はパラメータを送らず、既存の既定値を変えない。PAUSED (true のときだけ送る) / GROUP_ORDER / INCLUDE_PROPERTIES の扱いも変更していない。
- `src/session/namespaces.ts` で Range Filter の上限検証を外側と fill 内側の合計に変え、peer の MAX_FILTER_RANGES 超過をストリーム生成前に拒否するようにした。
- 受信 PUBLISH の許可集合は §9.8 の明示一覧を優先し、§3.6.2 の一般文だけでは広げない判断を `src/message/parameterScope.ts` に記録した (集合自体は変更なし)。
- テストは §9.17 の初期購読条件をすべて送れること、各値のワイヤ (varint / uint8 / Location Filter / FILL_PARAMETERS 内側)、RENDEZVOUS_TIMEOUT / NEW_GROUP_REQUEST を送らないこと、未指定時に空 Parameters になること、外側 + fill 内側の Range Filter 合計が上限超過ならストリーム未生成で throw し上限ちょうどなら生成されることを検証する。
- docs は 0925 で一括更新するため触っていない。

### 既知の制限

- §3.6.2 の一般文と §9.8 の明示一覧の不整合は spec 側に残っており、受信 PUBLISH の許可集合は明示一覧を優先している。
- `TracksSubscriptionState` は fill を保持していないため、受信 PUBLISH の FILL_PARAMETERS の関連付けは別 issue で扱う。
- 実リレー E2E は統合ブランチの制約 (ALPN は移行完了まで moqt-22) のため未実施である。

### 残課題 (別 issue で扱う)

- 受信 PUBLISH の fill 関連付け (0908)
- docs の一括更新 (0925)
