# 高レベル API が送信の reject を処理せず unhandled rejection になる

- Created: 2026-09-21
- Completed: 2026-09-29
- Branch: feature/fix-media-send-rejection-propagation
- Polished: 2026-09-23

## 目的

`src/createMediaPublisher.ts` は `void this.audioPublisher.sendObject(...)` と `void this.videoPublisher.sendObject(...)` で送信し、`src/publisher.ts` の `sendObject` が返す reject を誰も処理しない。`PublisherImpl.sendObject` は違反時に `handleError` で `onError` を通知したうえで reject を返す契約なので、通知自体は利用者に届いている。未処理なのは reject の方であり、`void` のまま放置すると実行環境へ unhandled rejection として渡り、アプリ側の `unhandledrejection` ハンドラや Node.js の既定動作を誘発する。`src/createMediaSubscriber.ts` の `void this.audioContext.resume()` と `void this.videoDecoder?.reset()` も同じく reject を処理しない。

現行の送信値 (内部採番の ID、priority は `PRIORITY_CATALOG` = 0 などの固定定数、status は常に NORMAL、END_OF_TRACK / END_OF_GROUP は送らない) では `sendObject` の事前検証の reject 条件に到達せず、委譲先の送信失敗も現行の経路では起きないため、この未処理 reject は現行では潜在している。`void` のままにする欠陥自体を直し、値や環境が変わっても unhandled rejection を出さない形にする。

## 現状

- `src/publisher.ts` の `sendObject` は、guard 違反 (END_OF_TRACK 後 / END_OF_GROUP 済み Group) と status 違反 (`validateSendStatusPayload`) で `handleError` を呼んでから `Promise.reject` を返す。委譲先 (`src/session/publish.ts`) の失敗も catch が `handleError` を呼び、ID 範囲検証の失敗は `handleError` と reject の両方になる。つまり reject 経路は必ず `onError` を伴う。このうち status 違反と END_OF_TRACK 後の guard は `src/publisher.test.ts` が、委譲先の ID / priority 検証は `src/session/publish.test.ts` が、END_OF_GROUP 済み Group への guard は委譲先経由の `src/session/publishSubgroupClose.test.ts` が固定している。`src/publisher.test.ts` には END_OF_GROUP 済み Group への guard の単体テストだけが無い
- `src/publisher.ts` の `guardSend` は Publisher が closed のとき同期 throw する。`sendObject` の戻り値は Promise なので closed だけは同期 throw になる。`src/createMediaPublisher.ts` の `handleAudioEncodedChunk` / `handleVideoEncodedChunk` は先頭の state ガードで closed を弾くためこの throw は現状到達しない。到達し得るのは委譲先が同期 throw する場合で、その場合は両ハンドラから例外が漏れ、通知も 0 回になる
- `src/publisher.ts` の `sendDatagram` の JSDoc は「closed 後は検証前に no-op で返す」と書いているが、実装は `guardSend` の同期 throw で、`src/publisher.test.ts` は throw を固定している。JSDoc が実装と食い違っている
- `src/createMediaSubscriber.ts` の `void this.audioContext.resume()` は reject を処理しない
- `src/createMediaSubscriber.ts` の `void this.videoDecoder?.reset()` は video decoder の error コールバックからのみ呼ばれる。`src/codec/VideoDecoder.ts` の `reset()` は例外を投げない `Promise<boolean>` を返し、false のときは Worker と `VideoDecoder` の破棄まで `reset()` の中で完結する。そのため呼び出し側に未処理の reject は残らず、打ち切りも `reset()` の中で完結するため戻り値は見ない
- `src/createMediaSubscriber.ts` の `void this.reconfigureAudioDecoder(...)` / `void this.reconfigureVideoDecoder(...)` は `await configure()` を catch して `onError` へ流すが、try の外にある同期 throw (`parseAudioCodec` / `resolveAudioChannelCount` / `parseVideoCodec` など) は async 関数の reject になり `void` 呼び出し側で未処理になる。ただし同じ値は `setupDecoders` が先に検査しているため現行では到達しない
- `src/createMediaPublisher.ts` の `publishCatalog` は `await this.catalogPublisher.sendObject(...)` を `start()` の try の中から呼ぶ。catalog の送信は groupId 0 / objectId 0 / `priority: PRIORITY_CATALOG` (= 0) 固定で事前検証に掛からず、委譲先の送信失敗は catch が通知して resolve するため、現行この経路は reject し得ない。将来 reject するようになると `start()` の catch が 2 回目を通知する
- `src/createMediaSubscriber.ts` の catalog fetch の `void this.session...` は `.catch` 済みである
- `src/session/lifecycle.ts` の `void publishCloseSubgroupStream(...)` は全経路が try/catch で `"reset"` を返すため reject し得ない。本 issue の対象外とする

## 設計方針

- 通知の担い手は publisher 側に固定する。`PublisherImpl.sendObject` の事前検証 (guard / status) は自ら `handleError` で通知してから reject し、委譲先 (`src/session/publish.ts` の `publishSendObject`) も reject の前に `handleError` する。高レベル API は「通知しない catch」で受ける。catch して `onError` を呼ぶと 1 件の失敗で 2 回通知になり、既存テストが固定する「1 reject = 1 通知」の不変条件と矛盾する
- `src/publisher.ts` の `sendObject` の JSDoc に、事前検証では自ら通知してから reject することと、closed では同期 throw することを明記する。`sendDatagram` の JSDoc の「closed 後は検証前に no-op で返す」も `guardSend` の同期 throw に合わせて直す。不変条件のうち `src/publisher.test.ts` に単体テストが無い END_OF_GROUP 済み Group への guard だけを足し、他の既存テストの期待値は変えない
- `guardSend` の同期 throw は reject に揃えない。`sendDatagram` と同じ同期 throw 契約とする。`createMediaPublisher.ts` の送信 2 箇所は `void sendObject(...).catch(...)` を try の中で受け、同期 throw は `onError` へ流す (同期 throw は通知を伴わないため。closed の throw は state ガードで到達せず、委譲先も現行は同期 throw しないため、これは将来の防御である)。記録用 publisher (`src/createMediaPublisher.test.ts`) は実インターフェースどおり `Promise<void>` を返すよう直す
- `publishCatalog` の `await sendObject(...)` は本 issue の対象外とする。reject は通知済みだが `start()` の catch が再度通知する経路で、通知を重複させない仕組み (reject の由来の分類) は別の設計変更になる。ここでは対象外と明記し、0679 で扱う
- 不変条件を「送信 reject は通知済み」と定める以上、高レベル API の `void` 送信 2 箇所の catch は通知しない。完了条件で `onError` に 1 回を要求するのは、同期 throw の経路、`resume()`、`reconfigure*` の 3 つである
- `void this.audioContext.resume()` は catch して `onError` へ流す
- `void this.videoDecoder?.reset()` は 0677 の完了後の契約に合わせる。0677 の `reset()` は例外を投げない `Promise<boolean>` を返し、`onError` も呼ばないため、呼び出し側は戻り値を見ずに `void` で呼ぶ (reject は起きないため catch も置かない)。`onError` は呼ばない。video decoder の error コールバックの中から呼ばれるため、通知すると恒久的な失敗で通知が反復する (同型の反復は 0651 が devtools 側で、0677 がライブラリ側で扱う)
- `reconfigureAudioDecoder` / `reconfigureVideoDecoder` は reject しない契約にし、関数全体 (try の外の同期 throw を含む) を catch して `onError` に 1 回流す。これで `void` 呼び出し側に未処理の reject が残らない。現行の値では到達しないが、将来の防御である
- フレーム処理の fire-and-forget 性 (落としても良いのは後続 Object で上書きされるため) は変えない。変えるのは reject の扱いだけである
- 対象は `src/createMediaPublisher.ts` / `src/createMediaSubscriber.ts` / `src/createMediaPublisher.test.ts` / `src/createMediaSubscriber.test.ts` / `CHANGES.md` と `src/publisher.ts` の JSDoc・不変条件テストとする。`sendDatagram` の挙動、`publishCatalog` の await 経路、セッション内部 (`src/session/lifecycle.ts`)、テストコード内の `void sendObject` は対象外とする (`sendDatagram` は JSDoc の是正のみ行う)
- 実装順は 0654 の完了後とする (`src/createMediaSubscriber.ts` と `src/createMediaSubscriber.test.ts` を 0654 が `disposeAllResources` と再開の契約で書き換えるため)。0649 は同じファイルを扱うため本 issue の後に実装し、0679 と 0681 は publisher 側を本 issue の後に扱う
- `CHANGES.md` の `## develop` の先頭に `[FIX]` を追記する (セクション内は新しい順)

## 完了条件

- `PublisherImpl.sendObject` の END_OF_GROUP 済み Group への guard が通知してから reject することを、単体層の `src/publisher.test.ts` に追加する (委譲先経由では `src/session/publishSubgroupClose.test.ts` が固定済み。status 違反と END_OF_TRACK 後の guard、委譲先の ID / priority 検証は既存テストのまま維持する)
- `createMediaPublisher` の送信箇所で reject が未処理にならない (unhandled rejection が 0)
- 委譲先が同期 throw する場合 (現行の実装では到達しないが、cast 注入で再現する) も `createMediaPublisher` の送信箇所から例外が漏れず、`onError` に 1 回届く
- `audioContext.resume()` の失敗が `onError` に 1 回届く
- video decoder の `reset()` は 0677 の契約 (`Promise<boolean>` を返し例外を投げない) の呼び出し側として扱われ、reject が未処理にならず、`onError` の回数も増えない。false のときの打ち切りは `reset()` の中で完結するため戻り値は見ない (catch も置かない)
- `reconfigureAudioDecoder` / `reconfigureVideoDecoder` が reject しなくなり、try の外の同期 throw も `onError` に 1 回届く
- `src/createMediaPublisher.test.ts` と `src/createMediaSubscriber.test.ts` に、reject する publisher / 同期 throw する publisher / reject する `resume()` を cast で注入して駆動するテストが追加される (`src/session.test.ts` の `unhandledRejection` 監視と同じ 50ms 待ちの方式)。`reset()` は 0677 の契約に合わせ、false を返す呼び出しで `onError` が増えないことを固定する。既存の `src/publisher.test.ts` の期待値は変更しない
- `src/publisher.ts` の `sendObject` / `sendDatagram` の JSDoc が実装 (事前検証の通知、closed の同期 throw) と一致する
- `CHANGES.md` の `## develop` の先頭に `[FIX]` が入る
- `npx vp check` / `npx vp test --run` が通る

## 参照

- 0677 (ライブラリ側の `reset()` の契約変更。reject しない `Promise<boolean>` を返す。0677 の 17 行目が reject の処理を本 issue の担当とし、本 issue は 0677 の完了後に実装する)
- 0654 (同じ `src/createMediaSubscriber.ts` と `src/createMediaSubscriber.test.ts` を `stop` / `close` の解放契約で書き換える。本 issue は 0654 の完了後に着手する。0654 と 0677 も同じファイルを触るため同時に進めず、0654 → 0677 の順で完了していることを前提とする)
- 0649 (`src/createMediaSubscriber.ts` の `start` の configure 順序。同じファイルを扱うため本 issue の後に実装する)
- 0679 (`publishCatalog` の await 経路で通知が重複する問題。本 issue の完了後に実装する)
- 0681 (publisher 側の stop / close の通知。同じファイルを扱うため本 issue と同時に進めない)
- 0651 (devtools 側で同型の復帰反復を復帰予算で扱う issue)

## 解決方法

`src/createMediaPublisher.ts` に private の `sendFrameFireAndForget(publisher, params)` を新設し、音声 / 映像の送信 2 箇所をここに集約した。`publisher.sendObject(params)` の reject は `.catch` で回収し、**呼び出し側では通知しない** (`PublisherImpl.sendObject` の事前検証と委譲先が reject の前に `handleError` で通知する契約であり、ここで通知すると 1 件の失敗で 2 回通知になるため)。委譲先が同期 throw する場合は通知を伴わないため、`try` / `catch` で受けて `onError` へ 1 回流す。通知の throw は吸収し、encoder の output コールバックへ例外を漏らさない。

`src/createMediaSubscriber.ts` の 3 箇所を直した。

- 自動再生ポリシー対応の `AudioContext.resume()` は `.catch` で受け、失敗を `onError` へ 1 回流す (通知の throw も吸収する)
- `reconfigureAudioDecoder` / `reconfigureVideoDecoder` は、codec / channels の解決を含む関数全体を `try` に入れ、同期 throw も `onError` へ 1 回流して reject しない契約にした。呼び出し側は `void` で呼ぶため、reject を残すと未処理の rejection になる
- 映像デコーダーの error コールバックを `handleVideoDecoderError` に切り出し、`onError` が throw しても復号順の初期化と `reset()` を続けるようにした。`reset()` は 0677 で例外を投げない `Promise<boolean>` になったため、結果は見ない (打ち切りは `reset()` の中で完結する)

`src/publisher.ts` の `sendObject` / `sendDatagram` の JSDoc を実装に合わせた。事前検証は自分で通知してから reject すること、closed では検証の前に同期 throw すること、`sendDatagram` の Forward State 0 は通知も throw もなく return することを明記し、公開 interface 側は契約 (reject は必ず通知を伴う。1 件の失敗につき通知 1 回) だけに整理した。あわせて `publisher.test.ts` に END_OF_GROUP 送信後の同一 Group への `sendObject` の単体テストを追加した (通知してから reject し、委譲先へ渡らない。別 Group へは送れる)。

テストは 15 件追加した (`createMediaPublisher.test.ts` / `createMediaSubscriber.test.ts` / `publisher.test.ts`)。reject する publisher / 同期 throw する publisher / reject する `resume()` / `onError` が throw する場合を cast で注入し、`unhandledRejection` を 50 ms 監視して 0 件であることと `onError` の回数を固定した。監視の定型は `src/testSupport/helpers.ts` の `withUnhandledRejectionWatch` / `waitForUnhandledRejectionDetection` に、AudioContext の差し替えは `withSuspendedAudioContext` に集約した。

`CHANGES.md` の `## develop` の FIX 群先頭に `[FIX]` を追記した。`publishCatalog` の await 経路は通知の由来を分類する別の設計が必要なため対象外とし、0679 で扱う。

`npx vp check` と `npx vp test --run` (3363 テスト) が通る。
