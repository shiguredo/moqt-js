# devtools の Subscriber に SUBSCRIBE_TRACKS の送信と PUBLISH の受理を追加する

- Created: 2026-11-13
- Completed: {YYYY-MM-DD}
- Branch: feature/add-devtools-subscribe-tracks
- Polished: 2026-11-13

## 目的

moqt-devtools の Subscriber は、catalog で広告されたトラックを `SUBSCRIBE` で購読する。catalog に載らないトラック (publisher が catalog を更新しない構成など) を購読する手段が無い。

`SUBSCRIBE_TRACKS` を送れば、namespace prefix に一致するトラックの `PUBLISH` が届く。ライブラリは `PUBLISH` に対して `PUBLISH_OK` を自動で返し、確立した購読を `TracksSubscriptionCallbacks.onPublishEstablished` でアプリへ渡す。

devtools は既定で `SUBSCRIBE_TRACKS` を送り、チェックを外すと送らないようにする。relay を通した `SUBSCRIBE_TRACKS` / `PUBLISH` のやり取りを実機で確認できる状態にする。

catalog に映像も音声も無い構成は、この issue の対象外とする (現状の開始フローは catalog の映像または音声を必須にしており、それを変えるのは別の作業である)。

## 現状

- `devtools/src/hooks/useSubscriber.ts` の `startSubscribing` は `subscribeTrack()` (`session.subscribe()`) だけを使う。`SUBSCRIBE_TRACKS` は送っていない
- 同じ関数は catalog を購読し、届いた catalog から `resolveCatalogMediaTracks` で映像と音声を決め、`subscribeTrack()` で購読する。catalog が届かない場合は `catalogSubscriptionTimeout` で失敗し、外側の catch が購読の開始失敗として `teardownSubscriber()` を呼ぶ
- `devtools/src/signals/subscriber.ts` の `SubscriberInstance` は `newGroupRequestEnabled` などのシグナルで購読の設定を持つ。`SUBSCRIBE_TRACKS` を送るかどうかの設定は無い
- `devtools/src/components/SubscriberPanel.tsx` の購読オプション行 (`subscriber-option-row`) には `NEW_GROUP_REQUEST` のチェックボックスがあり、`SUBSCRIBE` で効く指定と `REQUEST_UPDATE` で効く操作を分けて表示している。`SUBSCRIBE_TRACKS` の切り替えは無い
- namespace prefix は `settings.resolveConnectNamespace(target)` で解決している。`SUBSCRIBE_TRACKS` の prefix には同じ値を使える
- `session.subscribeTracks(namespacePrefix, callbacks, options?)` は `TracksSubscription` (state / `unsubscribe()` / `update()`) を返す。`options.authorizationToken` を渡せる
- `devtools/src/utils/subscriberResourceRelease.ts` の `releaseSubscriberResources` が購読の解除を集約している。`closeSubscriberResources` はその薄いラッパーであり、パネル削除経路の `removeSubscriber` は `releaseSubscriberResources` を直接呼ぶ
- `src/fullTrackName.ts` の `fullTrackNameKey(trackNamespace, trackName)` は、`/` 連結では衝突する Full Track Name を区別できる比較キーを返す
- `devtools/src/testSupport/fakes.ts` の `FakeSession.subscribeTracks` は未対応として throw する
- `startSubscribing` はモジュールレベルの `connect()` で Session を作る。`FakeSession` は `instance.session.value` に代入して後始末の経路を検証する用途で使われており、`startSubscribing` の送信経路には関与しない

## 設計方針

### 設定と UI

- `SubscriberInstance` に `subscribeTracksEnabled: Signal<boolean>` を追加する。既定値は `true` (既定で送る)
- `SubscriberPanel` の購読オプション行に `SUBSCRIBE_TRACKS` のチェックボックスを追加する
  - 購読の開始時に送る指定であり、購読中は変更できない (`isSubscribing` で disabled)
  - `data-testid` は `subscriber-subscribe-tracks` とする
  - 見出しは `SUBSCRIBE_TRACKS` とする。購読オプション行の見出しは「その指定がどのメッセージで効くか」を表しており、`SUBSCRIBE_TRACKS` は `SUBSCRIBE` とは別の制御メッセージ (§9.17) である。既存の `SUBSCRIBE` の見出しを再利用すると表示が誤りになり、`getByText("SUBSCRIBE", { exact: true })` を strict に検査している既存の UI テストも壊れる
  - 説明は英語 (devtools の UI は英語表記)。「Send SUBSCRIBE_TRACKS for the connect namespace prefix and accept PUBLISH for tracks under it」のように、何を送り何が起きるかを書く

### 送信の位置と catalog との関係

`SUBSCRIBE_TRACKS` は、catalog から購読するトラックを確定した後に送る。

- `resolveCatalogMediaTracks` で映像・音声を決め、中断判定を済ませた直後、eventtimeline・映像・音声の `SUBSCRIBE` を始める前に送る。catalog の到着前に `onPublish` が呼ばれることはないため、後述の一致判定に使う「実際に購読する full track name」がその時点で確定している。音声だけの catalog はここで `subscribeAudioOnly` へ分岐するため、`SUBSCRIBE` の後ろに単一の位置は無い
- 送信順序の都合で `onPublish` を保留キューへ積む設計は採らない。catalog を待つ間は `SUBSCRIBE_TRACKS` 自体を送らないため、保留は不要である
- 認可トークンは catalog と映像の `SUBSCRIBE` と同じく `session.setupAuthorizationToken` を `options.authorizationToken` に渡す (msf-01 §11.4.3 の MUST。catalog の `authInfo` は catalog を受信するまで分からないため、SETUP に載せたトークンを使う)。`exactOptionalPropertyTypes` が有効なため、`undefined` を明示せず条件スプレッドで載せる (既存の catalog と映像の `SUBSCRIBE` と同じ形)

### 送信の失敗

`subscribeTracks()` の Promise が reject した場合 (REQUEST_ERROR / セッション終了) は、購読の開始を失敗させず、警告ログを出して catalog の購読を続ける。

- `SUBSCRIBE_TRACKS` は付加的な機能であり、非対応の relay やトークン不足で既存の catalog 購読まで失うのは行き過ぎである
- 既定 true で送るため、この扱いにしないと既存環境が動かなくなる
- ログは `addLog("warn", ...)` で理由を出す

### PUBLISH の受理

`TracksSubscriptionCallbacks.onPublish` は `SubscribeCallbacks` を返す必要がある。

- 実際に `SUBSCRIBE` で購読する full track name と一致する `PUBLISH` は、`{ object: () => {} }` を返して Object を捨てる。同じトラックを `SUBSCRIBE` と `PUBLISH` の両方で購読すると、同じ Object を 2 系統で受け取るためである (この issue では PUBLISH 側を復号しないが、復号を足す後続 issue で二重復号になる)
- 一致判定は `fullTrackNameKey` を使う。比較するのは次の 2 つである
  - `PUBLISH` 側: `fullTrackNameKey([...namespacePrefix, ...namespaceSuffix], trackName)`
  - 購読済み側: 開始時に `SUBSCRIBE` した各トラックの `fullTrackNameKey(namespacePrefix, subscribedTrackName)`
- 購読済みの集合は、開始時に確定した次の 4 つに固定する (catalog が更新されても変えない)。eventtimeline は `resolveEventTimelineTrack(receivedCatalog)` で別途解決する (`resolveCatalogMediaTracks` は映像と音声しか返さない)
  - catalog 自身 (`CATALOG_TRACK_NAME`)
  - 映像 (`resolveCatalogMediaTracks` の video。音声だけの catalog では存在しない)
  - 音声 (同 audio)
  - eventtimeline (`resolveEventTimelineTrack` で解決したもの。存在する場合のみ)
- 一致しない `PUBLISH` は受理し、Object を受け取る `SubscribeCallbacks` を返す
  - この issue では Object を復号しない。受け取った件数を数えるだけにする (復号は別 issue)
- 受理した `PUBLISH` は `addLog` で track 名と namespace suffix を出す

### 確立の記録

`onPublishEstablished(namespaceSuffix, trackName, subscriber, callbacks)` で、確立した購読を記録する。

- `SubscriberInstance` に `publishedSubscriptions: Signal<PublishedSubscription[]>` を追加し、確立した順に積む。`PublishedSubscription` は `trackName` / `namespaceSuffix` / `subscriber` / `duplicate` (購読済みのため Object を捨てる購読か) を持つ
- `addLog` で track 名・namespace suffix・重複かどうかを出す
- 保持した `Subscriber` は後続の復号 issue で使う。この issue では参照を保持するだけにする
- publisher の終了 (`end`) とエラー (`error`) は `addLog` で出す。購読の一覧からは消さない (PUBLISH_DONE は購読の終了であり、状態は `subscriber.state` で分かる)

### 停止時の後始末

停止時は、確立した PUBLISH の購読を購読単位で解除する。`TracksSubscription.unsubscribe()` だけでは、既に確立した PUBLISH の購読は残る (§3.6「Cancelling a SUBSCRIBE_TRACKS has no effect on existing subscriptions.」)。

- `releaseSubscriberResources` で次を行う。`closeSubscriberResources` だけに足すとパネル削除経路 (`removeSubscriber` → `releaseSubscriberResources`) が漏れる
  - 保持している `TracksSubscription` の `unsubscribe()` を呼ぶ (fire-and-forget、失敗は握り潰す)
  - `publishedSubscriptions` の各 `subscriber.unsubscribe()` を呼ぶ (同じく fire-and-forget)
  - `publishedSubscriptions` を空にする
- `SubscriberInstance` のフィールド名は `tracksSubscription: Signal<TracksSubscription | null>` とする
- `resetSubscriberState` でも `tracksSubscription` を `null`、`publishedSubscriptions` を空、`publishedObjectsReceived` を 0 にする
- `onPublish` / `onPublishEstablished` は開始時の `AbortSignal` を見て、停止後の呼び出しを無視する。`TracksSubscription.unsubscribe()` と `PUBLISH_OK` の送信が競合すると、解除後に `onPublishEstablished` が呼ばれ得るためである (ライブラリの JSDoc に明記されている)
- `subscribeTracks()` の await 中に停止された場合に備え、解決後に `checkAborted(signal, () => { void tracksSubscription.unsubscribe().catch(() => {}); })` で後始末し、`tracksSubscription` へ代入せずに return する。既存の `subscribeTrack()` の await 後と同じ形である。代入してしまうと、停止で null にしたフィールドが再び埋まり、その購読が解除されない

### ログの頻度

受信 Object の件数は `SubscriberInstance` の `publishedObjectsReceived: Signal<number>` に持ち (PUBLISH から受理した全購読の累計)、件数のログは停止時の 1 回だけ出す。確立のログは `onPublishEstablished` の 1 回だけ出す。

- 既定の設定では映像 30 個/秒 + 音声 50 個/秒程度が届く。1 Object ごとに `addLog` を呼ぶと `MAX_LOGS` (1000) が約 12 秒で埋まり、Debug パネルが実用にならない
- 停止時のログには累計件数を出す

### テスト

次の純関数を切り出し、単体テストで検証する。`startSubscribing` はモジュールレベルの `connect()` を使うため、フック全体を FakeSession では駆動できない。

- `shouldSendSubscribeTracks(instance): boolean` — `subscribeTracksEnabled` が true かつ `isStopping` が false のときに true を返す。購読の開始処理の途中 (catalog の購読中) に呼ぶため、`isSubscribing` (`subscribed || starting`) を条件にしない。開始処理中は `starting` が true であり、それを条件にすると送信されない
- `createTracksSubscriptionCallbacks(instance, signal, namespacePrefix, subscribedTrackNames): TracksSubscriptionCallbacks` — `onPublish` の一致判定と `onPublishEstablished` の記録を行う。`namespacePrefix` は PUBLISH 側のキー生成と購読済みキーの生成の両方に使い、`subscribedTrackNames` は実際に `SUBSCRIBE` した Track Name の配列である
- `sendSubscribeTracks(session, instance, signal, namespacePrefix, subscribedTrackNames): Promise<void>` — 設定を見て `subscribeTracks()` を送り、成功したら `tracksSubscription` に代入し、失敗したら `addLog("warn", ...)` を出して続行する。await 中の停止は `checkAborted` で後始末する。`startSubscribing` はこの関数を 1 回呼ぶだけにし、送信経路を `FakeSession` で検証できるようにする
- `sendSubscribeTracks` の送信の有無・引数 (prefix と認可トークン)・reject 時の継続・await 中の停止を `FakeSession` と `FakeTracksSubscription` で検証する
- `releaseSubscriberResources` の解除は `FakeSession` と `FakeTracksSubscription` で検証する

`FakeSession.subscribeTracks` は、`subscribeTracksCalls` に引数を記録し、`unsubscribe` と `update` を持つ `TracksSubscription` を返すよう実装する。既存の `FakeSession` と同じくモックライブラリは使わない。

### 対象外

- `PUBLISH` で確立した購読の Object を復号して映像・音声として再生すること。既存の復号は catalog のトラックを前提にしており、複数の PUBLISH 購読を並べる UI も要るため、別 issue とする
- catalog に映像も音声も無い構成で購読を開始すること (現行の開始フローを変える別の作業)
- `SUBSCRIBE_TRACKS` の namespace prefix を UI から変更すること。接続の namespace と同じ値を使う
- `TracksSubscription.update()` (prefix / PAUSED の更新)
- relay を相手にした E2E テスト。relay の `SUBSCRIBE_TRACKS` 対応状況に依存するため、別 issue とする

## 完了条件

- `SubscriberInstance` に `subscribeTracksEnabled` (既定 true)、`tracksSubscription`、`publishedSubscriptions`、`publishedObjectsReceived` (既定 0) がある
- `SubscriberPanel` に `subscriber-subscribe-tracks` のチェックボックスがあり、購読中は変更できない
- `shouldSendSubscribeTracks` が、`subscribeTracksEnabled` が true かつ `isStopping` が false のときに true を返す
- 購読の開始時、`shouldSendSubscribeTracks` が true なら `session.subscribeTracks(namespacePrefix, callbacks, options)` が呼ばれる。prefix は接続の namespace と同じで、`options` には `session.setupAuthorizationToken` を条件スプレッドで載せる
- チェックを外した場合、`subscribeTracks` は呼ばれない
- `SUBSCRIBE_TRACKS` が REQUEST_ERROR で失敗しても購読の開始は続き、警告が `addLog` に出る
- `createTracksSubscriptionCallbacks` の `onPublish` が、購読済みの full track name と一致する `PUBLISH` に対して Object を捨てる `SubscribeCallbacks` を返す。判定は `fullTrackNameKey` を使い、namespace suffix が空でない PUBLISH も正しく比較する
- 一致しない `PUBLISH` は受理され、受け取った Object の件数が数えられる
- `onPublishEstablished` で確立した購読が `publishedSubscriptions` に積まれ、停止時に各 `Subscriber.unsubscribe()` が呼ばれる
- 停止時に `TracksSubscription.unsubscribe()` が呼ばれ、`tracksSubscription` が `null`、`publishedSubscriptions` が空になる
- 停止後に `onPublish` / `onPublishEstablished` が呼ばれても、`publishedSubscriptions` は空のままである
- `subscribeTracks()` の await 中に停止された場合、解決後に `TracksSubscription.unsubscribe()` が呼ばれ、`tracksSubscription` は `null` のままである
- `FakeSession.subscribeTracks` が実装され、`subscribeTracksCalls` で引数を検証できる
- 次のテストがある
  - `shouldSendSubscribeTracks` の判定
  - `createTracksSubscriptionCallbacks` の一致判定 (suffix あり・なし、catalog 自身、映像、音声、eventtimeline、一致しないトラック)
  - `onPublishEstablished` の記録と停止後の無視
  - `releaseSubscriberResources` が `TracksSubscription` と各 `Subscriber` を解除し、配列を空にすること
  - `sendSubscribeTracks` が、設定が true のときに `subscribeTracks` を呼び、false のときは呼ばないこと
  - `sendSubscribeTracks` が、prefix と `session.setupAuthorizationToken` を渡すこと
  - `sendSubscribeTracks` が、`subscribeTracks()` の reject で購読の開始を止めず、警告ログを出すこと
  - `sendSubscribeTracks` が、await 中に停止した場合に解決後の `TracksSubscription` を解除し、フィールドに代入しないこと
  - チェックボックスの既定値と disabled (vitest に DOM 環境が無いため、relay を起動しない Playwright のテストで行う。既存の devtools の UI テストと同じ形)
- `vp check` / `vp exec tsc --noEmit` / `vp test run` が通る

`CHANGES.md` は MOQT RFC ドラフト中のため更新しない (`CODEBASE.md` の特別ルール)。

## 参照

- `devtools/src/hooks/useSubscriber.ts` の `useSubscriber` / `startSubscribing` / `closeSubscriberResources`
- `devtools/src/signals/subscriber.ts` の `SubscriberInstance` / `createSubscriberInstance` / `resetSubscriberState`
- `devtools/src/components/SubscriberPanel.tsx` の購読オプション行
- `devtools/src/testSupport/fakes.ts` の `FakeSession`
- `devtools/src/utils/subscriberResourceRelease.ts` の `releaseSubscriberResources`
- `devtools/src/signals/connectionSettings.ts` の `resolveConnectNamespace`
- `devtools/src/signals/debugLog.ts` の `addLog` / `MAX_LOGS`
- `src/fullTrackName.ts` の `fullTrackNameKey`
- `src/msf/version.ts` の `CATALOG_TRACK_NAME`
- `src/session.ts` の `subscribeTracks`
- `src/session/publicTypes.ts` の `TracksSubscriptionCallbacks` / `TracksSubscription` / `SubscribeCallbacks` / `SubscribeTracksOptions`
- `src/subscriber.ts` の `Subscriber`
- draft-ietf-moq-transport-23 §3.6 (Subscribing to Tracks by Prefix) / §3.6.2 / §3.6.3 / §9.17 (SUBSCRIBE_TRACKS) / §9.8 (PUBLISH)
- draft-ietf-moq-msf-01 §11.4.3 (Authorization Token)

## 解決方法

{未着手}
