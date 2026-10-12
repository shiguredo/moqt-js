# PUBLISH に AUTHORIZATION TOKEN を載せられない

- Created: 2026-09-21
- Completed: 2026-10-12
- Branch: feature/add-publish-authorization-token
- Polished: 2026-09-29

## 目的

draft-ietf-moq-msf-01 §11.4.3 は、track に紐づくトークンを AUTHORIZATION TOKEN パラメータを受け付けるすべての制御メッセージに含める MUST を定め、original publisher については PUBLISH と PUBLISH_NAMESPACE を挙げる。PUBLISH_NAMESPACE には指定手段があるのに PUBLISH には無く、認可付きで publish できない。

## 現状

- `src/session/publicTypes.ts` の `PublishOptions` に `authorizationToken` フィールドが無い
- `ConnectOptions` / `SubscribeOptions` / `FetchOptions` / `TrackStatusOptions` / `PublishNamespaceOptions` には `authorizationToken` がある
- `src/session/params.ts` の `buildPublishParameters` は EXPIRES と FORWARD しか作らず、`authorizationToken` を参照しない
- 同じファイルの `buildPublishTrackProperties` もトークンを扱わない (AUTHORIZATION TOKEN は Message Parameter であり Track Property ではない)
- PUBLISH を組み立てる `src/session/requests.ts` の `requestsPublish` は `buildPublishParameters(options)` に `PublishOptions` をそのまま渡すため、フィールドを追加すれば配線は既存のままで通る

## 設計方針

- `PublishOptions.authorizationToken` を追加する
- `buildPublishParameters` で `encodeAuthorizationTokenParameter` を積む。他の経路と同じく未指定なら積まない
- `src/session/params.test.ts` に、指定時に AUTHORIZATION TOKEN パラメータが 1 つ載ることと、未指定時に載らないことを固定するテストを追加する

## 完了条件

- `publish()` の `authorizationToken` が PUBLISH の Message Parameter として送られる
- 未指定時にパラメータが増えない
- 追加したテストと既存テストが通る

## 参照

- draft-ietf-moq-msf-01 §11.4.3 (track に紐づくトークンは AUTHORIZATION TOKEN を受け付ける全制御メッセージに含める MUST。original publisher は PUBLISH と PUBLISH_NAMESPACE)
- draft-ietf-moq-transport-21 §9.20.3 (AUTHORIZATION TOKEN Parameter)

## 解決方法

`PublishOptions.authorizationToken` を追加し、`buildPublishParameters` (`src/session/params.ts`) が未指定でなければ `encodeAuthorizationTokenParameter` を積むようにした。PUBLISH を組み立てる `requestsPublish` (`src/session/requests.ts`) は `requestsNormalizeAuthorizationToken` で SETUP の REGISTER の登録成否に応じた形 (USE_ALIAS / USE_VALUE) へ正規化してから `buildPublishParameters` へ渡す。

`src/session/params.test.ts` に次の 2 件を固定した。

- `buildPublishParameters: authorizationToken が AUTHORIZATION_TOKEN パラメータになる`
- `buildPublishParameters: authorizationToken 省略時は AUTHORIZATION_TOKEN を送らない`

`vp test` (213 ファイル / 3873 テスト) と `vp check` が通ることを確認した。
