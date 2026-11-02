# 高レベル購読で publisher の出現待ちを表現できない

- Created: 2026-11-02
- Completed: {YYYY-MM-DD}
- Branch: feature/add-media-subscriber-rendezvous-timeout
- Polished: {YYYY-MM-DD}

## 目的

1:N の live 視聴では、視聴者が配信者より先に接続するのが普通である。現状の高レベル購読は配信者の不在を購読の失敗として即座に返すため、「配信者が現れるまで待つ」を表現できず、アプリが指数バックオフの再試行を書くか再読み込みするしかない。draft-ietf-moq-transport-22 §9.20.6 の `RENDEZVOUS_TIMEOUT` を高レベル API から指定できるようにし、購読開始の失敗を再試行の可否で判断できる契約を文書化する。

## 現状

- `MediaSubscriberOptions` に `RENDEZVOUS_TIMEOUT` に相当する指定が無い。
- `CatalogSubscription.subscribe` は catalog の `SUBSCRIBE` に `filter: { nextObject: true }` と認可トークンだけを渡し、`MediaSubscriberImpl.subscribeMediaTracks` も認可トークンだけを渡す。`SubscribeOptions.rendezvousTimeout` は常に省略される。
- draft-ietf-moq-transport-22 §9.20.6: `RENDEZVOUS_TIMEOUT` を省略した場合の既定は 0 であり、publisher が居なければ relay は即 `REQUEST_ERROR` (`DOES_NOT_EXIST`) を返す MUST。
- その失敗は `session.subscribe` の reject として `start()` の失敗になり、`RequestError` (`RequestErrorCode.DOES_NOT_EXIST`) が throw されて `onError` にも渡る。ただし `docs/HIGH_LEVEL_API.md` は `start()` の失敗の型と、code による再試行可否の判断を定めていない。catalog の受信タイムアウト (`catalog receive timeout`) は素の `Error` であり、購読の失敗と区別できない。
- catalog の受信タイムアウト `CATALOG_RECEIVE_TIMEOUT` (5000 ms) は、`CatalogSubscription.subscribe` が `session.subscribe` を await する前にタイマーを張る。relay が publisher を待って `SUBSCRIBE_OK` を保留する場合、`RENDEZVOUS_TIMEOUT` に 5000 ms を超える値を指定すると、先に `catalog receive timeout` で失敗する。
- 低レベル API には `SubscribeOptions.rendezvousTimeout` (ミリ秒、`bigint`) があるが、`docs/LOW_LEVEL_API.md` に記述が無い。
- `MediaSubscriberState` は `"created"` / `"subscribing"` / `"active"` / `"stopped"` / `"closed"` であり、待ちを表す状態は無い。

## 設計方針

- `MediaSubscriberOptions.rendezvousTimeout?: number` (ミリ秒) を追加し、catalog と媒体トラックの両方の `SUBSCRIBE` に `SubscribeOptions.rendezvousTimeout` として渡す。低レベルの型は `bigint` なので変換する。
- 値の検証は `createMediaSubscriber` の時点で行う (`preDecodeDelayMs` の `resolvePreDecodeDelayMs` と同じ方針)。0 以上の整数以外は拒否する。
- draft-22 §9.20.6 のとおり relay は要求より短い時間で `TIMEOUT` を返し得る。指定した時間は上限であり、早く失敗することがあると文書化する。
- catalog の受信タイムアウトは `SUBSCRIBE_OK` が届いた後に数え始める。`SUBSCRIBE_OK` より前に Object は届かず、待ち時間と受信タイムアウトを混ぜると `RENDEZVOUS_TIMEOUT` に 5000 ms を超える値を指定できないためである。
- 購読の失敗の契約を `docs/HIGH_LEVEL_API.md` に書く。`start()` の失敗は `RequestError` (relay の `REQUEST_ERROR`) / `SessionError` / ライブラリ由来の `Error` のいずれかであり、再試行の可否は次のとおり判断する。
  - `RequestErrorCode.DOES_NOT_EXIST` と `TIMEOUT`: publisher が居ない。再試行の対象
  - `RequestErrorCode.UNAUTHORIZED` / `MALFORMED_AUTH_TOKEN` / `EXPIRED_AUTH_TOKEN` / `NOT_SUPPORTED`: 恒久の失敗
  - その他の `RequestError`: `retryInterval` とあわせてアプリが判断する
  - `SessionError` と GOAWAY 由来の失敗: 接続を作り直す
    新しいエラー型は作らない。`RequestError` は既に `code` / `retryInterval` / `redirect` を持ち、`moqt-js` から import できる。
- 待ちを表す状態は追加しない。待ちは `start()` が解決しない時間として表し、`"subscribing"` のまま待つことを文書化する。状態を増やすと状態遷移と既存の利用者の分岐を壊すためである。
- `close()` とピア起点の close は Session の終了で `session.subscribe` を reject させ、待ちを打ち切る (待ちが残って `start()` がハングしないことをテストで固定する)。
- 自動のバックオフ再試行と、複数 namespace を購読するプールは本 issue の範囲外とする。
- 実リレーの E2E は publisher の不在を作れる場合にだけ追加する (実リレーで通ることを確認できた経路だけ。`issues/0817-add-relay-tests.md` の方針)。

## 完了条件

- `rendezvousTimeout` を指定すると、catalog と媒体トラックの `SUBSCRIBE` に `RENDEZVOUS_TIMEOUT` が載る
- 未指定では載らない (既定 0 のまま)
- `rendezvousTimeout` に 5000 ms を超える値を指定しても、`catalog receive timeout` が先に発火しない (受信タイムアウトは `SUBSCRIBE_OK` の後に数える)
- `rendezvousTimeout` に負数・非整数・非有限を渡すと `createMediaSubscriber` が拒否する
- relay が `TIMEOUT` / `DOES_NOT_EXIST` を返したとき、`start()` の失敗が `RequestError` で、code を読める
- `start()` の待ちの間に `close()` またはピア起点の close が起きた場合に、待ちが打ち切られてハングしない
- `docs/HIGH_LEVEL_API.md` に `rendezvousTimeout` と `start()` の失敗の契約を、`docs/LOW_LEVEL_API.md` に `rendezvousTimeout` の意味を書く
- `npx vp check` と `npx vp test --run` が通る

`CHANGES.md` は MOQT RFC ドラフト中のため更新しない (`CODEBASE.md` の特別ルール)。

## 解決方法

{未着手}

## 参照

- `src/codec/types.ts` の `MediaSubscriberOptions` / `MediaSubscriberState`
- `src/createMediaSubscriber.ts` の `MediaSubscriberImpl.start` / `subscribeMediaTracks` / `resolvePreDecodeDelayMs`
- `src/mediaSubscriber/catalogSubscription.ts` の `CatalogSubscription.subscribe` / `CATALOG_RECEIVE_TIMEOUT`
- `src/session/publicTypes.ts` の `SubscribeOptions.rendezvousTimeout`
- `src/session/params.ts` の `RENDEZVOUS_TIMEOUT` のエンコード
- `src/error.ts` の `RequestError` / `RequestErrorCode`
- `docs/HIGH_LEVEL_API.md` の `MediaSubscriber` と catalog の受信タイムアウトの記述
- draft-ietf-moq-transport-22 §9.20.6
- `issues/0817-add-relay-tests.md` (実リレーの E2E の方針)
