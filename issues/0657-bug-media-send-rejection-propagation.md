# 高レベル API が送信の reject を処理せず unhandled rejection になる

- Created: 2026-09-21
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-media-send-rejection-propagation
- Polished: 2026-09-21

## 目的

`src/createMediaPublisher.ts` は `void this.audioPublisher.sendObject(...)` と `void this.videoPublisher.sendObject(...)` で送信し、`src/publisher.ts` の `sendObject` が返す reject を誰も処理しない。`PublisherImpl.sendObject` は違反時に `handleError` で `onError` を通知したうえで reject を返す契約なので、通知自体は利用者に届いている。未処理なのは reject の方であり、実行環境へ unhandled rejection として渡ってアプリ側の `unhandledrejection` ハンドラや Node.js の既定動作を誘発する。`src/createMediaSubscriber.ts` の `void this.audioContext.resume()` と `void this.videoDecoder?.reset()` も同じく reject を処理しない。

## 現状

- `src/publisher.ts` の `sendObject` は、guard 違反 (END_OF_TRACK 後 / END_OF_GROUP 済み Group) と status 違反 (`validateSendStatusPayload`) で `handleError` を呼んでから `Promise.reject` を返す。委譲先 (`src/session/publish.ts`) の失敗も catch が `handleError` を呼び、ID 範囲検証の失敗は `handleError` と reject の両方になる。つまり reject 経路は必ず `onError` を伴う。このうち status 違反と END_OF_TRACK 後の guard は `src/publisher.test.ts` が、委譲先の ID / priority 検証は `src/session/publish.test.ts` が、END_OF_GROUP 済み Group への guard は委譲先経由の `src/session/publishSubgroupClose.test.ts` が固定している。`src/publisher.test.ts` には END_OF_GROUP 済み Group への guard の単体テストだけが無い
- `src/publisher.ts` の `guardSend` は Publisher が closed のとき同期 throw する。`sendDatagram` と同じ契約だが、`sendObject` の戻り値は Promise なので closed だけは同期 throw になる。`src/createMediaPublisher.ts` の `handleAudioEncodedChunk` / `handleVideoEncodedChunk` は先頭の state ガードで closed を弾くためこの throw は現状到達しない。到達し得るのは委譲先が同期 throw する場合で、その場合は両ハンドラから例外が漏れ、通知も 0 回になる
- `src/createMediaSubscriber.ts` の `void this.audioContext.resume()` は reject を処理しない
- `src/createMediaSubscriber.ts` の `void this.videoDecoder?.reset()` は video decoder の error コールバックからのみ呼ばれる。`src/codec/VideoDecoder.ts` の `reset()` は失敗を `callbacks.error` に流さず reject するだけである
- `src/createMediaSubscriber.ts` の `void this.reconfigureAudioDecoder(...)` / `void this.reconfigureVideoDecoder(...)` は `await configure()` を catch して `onError` へ流すが、try の外にある同期 throw (`parseAudioCodec` / `resolveAudioChannelCount` / `parseVideoCodec` など) は async 関数の reject になり `void` 呼び出し側で未処理になる
- `src/createMediaPublisher.ts` の `publishCatalog` は `await this.catalogPublisher.sendObject(...)` を `start()` の try の中から呼ぶ。catalog の送信は groupId 0 / objectId 0 / priority 255 固定で事前検証に掛からず、委譲先の送信失敗は catch が通知して resolve するため、現行この経路は reject し得ない。将来 reject するようになると `start()` の catch が 2 回目を通知する
- `src/createMediaSubscriber.ts` の catalog fetch の `void this.session...` は `.catch` 済みである
- `src/session/lifecycle.ts` の `void publishCloseSubgroupStream(...)` も reject し得るが、セッション内部の後始末であり本 issue の対象外とする

## 設計方針

- 通知の担い手は publisher 側に固定する。`PublisherImpl.sendObject` の事前検証 (guard / status) は自ら `handleError` で通知してから reject し、委譲先 (`src/session/publish.ts` の `publishSendObject`) も reject の前に `handleError` する。高レベル API は「通知しない catch」で受ける。catch して `onError` を呼ぶと 1 件の失敗で 2 回通知になり、既存テストが固定する「1 reject = 1 通知」の不変条件と矛盾する
- `src/publisher.ts` の `sendObject` の JSDoc に、事前検証では自ら通知してから reject することと、closed では同期 throw することを明記する。不変条件のうち `src/publisher.test.ts` に単体テストが無い END_OF_GROUP 済み Group への guard だけを足し、他の既存テストの期待値は変えない
- `guardSend` の同期 throw は reject に揃えない。`sendDatagram` と同じ同期 throw 契約とする。`createMediaPublisher.ts` の送信 2 箇所は `void sendObject(...).catch(...)` を try の中で受け、同期 throw は `onError` へ流す (同期 throw は通知を伴わないため。closed の throw は state ガードで到達せず、委譲先も現行は同期 throw しないため、これは将来の防御である)。記録用 publisher (`src/createMediaPublisher.test.ts`) は実インターフェースどおり `Promise<void>` を返すよう直す
- `publishCatalog` の `await sendObject(...)` は本 issue の対象外とする。reject は通知済みだが `start()` の catch が再度通知する経路で、通知を重複させない仕組み (reject の由来の分類) は別の設計変更になる。ここでは対象外と明記し、別 issue とする
- 不変条件を「送信 reject は通知済み」と定める以上、高レベル API の `void` 送信 2 箇所の catch は通知しない。完了条件の「`onError` に 1 回」はこの 2 箇所と `resume()` を指す
- `void this.audioContext.resume()` は catch して `onError` へ流す
- `void this.videoDecoder?.reset()` は catch のみとし、`onError` は呼ばない。video decoder の error コールバックの中から呼ばれるため、通知すると恒久的な失敗で通知が反復する (同型の反復は 0651 が devtools 側で扱い、ライブラリ側は別 issue)
- `reconfigureAudioDecoder` / `reconfigureVideoDecoder` は reject しない契約にし、関数全体 (try の外の同期 throw を含む) を catch して `onError` に 1 回流す。これで `void` 呼び出し側に未処理の reject が残らない
- フレーム処理の fire-and-forget 性 (落として良いのは後続 Object で上書きされること) は変えない。変えるのは reject の扱いだけである
- 対象は `src/createMediaPublisher.ts` / `src/createMediaSubscriber.ts` と `src/publisher.ts` の JSDoc・不変条件テスト、`src/createMediaPublisher.test.ts` の記録用 publisher とする。`sendDatagram`、`publishCatalog` の await 経路、セッション内部 (`src/session/lifecycle.ts`)、テストコード内の `void sendObject` は対象外とする
- `CHANGES.md` の `## develop` の先頭に `[FIX]` を追記する (セクション内は新しい順)

## 完了条件

- `PublisherImpl.sendObject` の END_OF_GROUP 済み Group への guard が通知してから reject することを、単体層の `src/publisher.test.ts` に追加する (委譲先経由では `src/session/publishSubgroupClose.test.ts` が固定済み。status 違反と END_OF_TRACK 後の guard、委譲先の ID / priority 検証は既存テストのまま維持する)
- `createMediaPublisher` の送信箇所で reject が未処理にならない (unhandled rejection が 0)
- 委譲先が同期 throw する場合 (現行の実装では到達しないが、cast 注入で再現する) も `createMediaPublisher` の送信箇所から例外が漏れず、`onError` に 1 回届く
- `audioContext.resume()` の失敗が `onError` に 1 回届く
- `videoDecoder.reset()` の失敗は unhandled rejection にならず、`onError` の回数も増えない
- `reconfigureAudioDecoder` / `reconfigureVideoDecoder` が reject しなくなり、try の外の同期 throw も `onError` に 1 回届く
- `src/createMediaPublisher.test.ts` と `src/createMediaSubscriber.test.ts` に、reject する publisher / 同期 throw する publisher / reject する `resume()` / reject する `reset()` を cast で注入して駆動するテストが追加される (`src/session.test.ts` の `unhandledRejection` 監視と同じ 50ms 待ちの方式)。既存の `src/publisher.test.ts` の期待値は変更しない
- `CHANGES.md` の `## develop` の先頭に `[FIX]` が入る
- `npx vp check` / `npx vp test --run` が通る

## 参照

- 0651 (devtools 側で同型の復帰反復を復帰予算で扱う issue。未着手。ライブラリ側の `reset()` は別 issue)

## 解決方法

{未着手}
