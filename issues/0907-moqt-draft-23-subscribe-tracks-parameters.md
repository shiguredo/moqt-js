# SUBSCRIBE_TRACKS の初期パラメータを draft 23 の明示一覧に揃える

- Created: 2026-11-03
- Completed: {YYYY-MM-DD}
- Branch: feature/change-subscribe-tracks-parameters
- Polished: {YYYY-MM-DD}

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
- builder / 公開型 / callback に渡す購読条件 / API 文書の一覧が一致する

## 参照

- `refs/moq/draft-ietf-moq-transport-23.txt` §3.6.2 / §9.17 / §9.19.3〜§9.19.15
- `src/session/publicTypes.ts` の `SubscribeTracksOptions`、`src/session/params.ts` の `buildSubscribeTracksParameters`
- `src/session/namespaces.ts` の `namespacesSubscribeTracks`

## 解決方法

{未着手}
