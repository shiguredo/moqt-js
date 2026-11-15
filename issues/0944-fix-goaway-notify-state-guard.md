# notifyGoaway が close 後や旧セッションの遅延 GOAWAY を通知し得る

- Created: 2026-11-03
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-goaway-notify-state-guard
- Polished: 2026-11-15
- Refreshed: 2026-11-14

## 目的

高レベル API の `notifyGoaway` は Session の状態や世代を見ずに `onGoaway` を呼ぶ。そのため `close()` / `stop()` の完了後や、旧セッションのコールバックが遅延して届いた場合にも `onGoaway` が呼ばれ得る。docs と JSDoc は「`onGoaway` の後に `onClose` が続くことがある」と書くが、`onClose` の後に `onGoaway` が届くことは契約に無く、アプリが再接続を二重に始める恐れがある。

## 現状

- `src/createMediaSubscriber.ts` / `src/createMediaPublisher.ts` の `notifyGoaway` は `lastGoawayUri` と比較するだけで、state や `sessionGeneration` を見ない
- `connectToServer` は接続の開始時に `lastGoawayUri` を戻す。`onSessionClose` / `onSessionError` の閉包は `startGeneration` との世代比較で旧セッションの通知を捨てるが、`onSessionGoaway` は世代を捕捉しないため旧セッションの GOAWAY を識別できない
- subscriber / publisher のリクエストストリームの `goaway` コールバック (catalog SUBSCRIBE / FETCH、音声・映像 SUBSCRIBE、PUBLISH_NAMESPACE、catalog / 音声 / 映像 PUBLISH) も世代を捕捉せず、`notifyGoaway` をそのまま呼ぶ
- 低レベルの制御ループは `await reader.read()` の後で状態を再確認しないため、close 中に読めた GOAWAY が `onClose` の後に届く余地がある
- 既存の `src/createMediaPublisher.test.ts` の `createStartConnectHarness` で、`publisher.close()` の後に `notifySessionGoaway` を呼ぶと `onGoaway` が呼ばれることを確認済み

## 設計方針

`notifyGoaway` の入口で状態と世代を確認し、`"closed"` の状態や旧世代の通知を捨てる。判定は `lastGoawayUri` の比較・更新より前に置き、捨てた通知で現在の抑止状態を壊さない。

- `notifyGoaway(newSessionUri, generation)` は、`generation !== this.sessionGeneration` または `this.state` が `"closed"` なら捨てる
  - `stop()` は終端ではないため state では捨てないが、停止の解放 (`disposeAllResources`) で `sessionGeneration` が進むため、停止後に届く旧 session の GOAWAY は世代の比較で捨てられる。`stop()` からの再 `start()` の実行中は publisher の state が `"stopped"` のままでも、新しい session の GOAWAY は世代が一致するため通知する
  - `close()` の解放中は `state` が `"closed"` になる前でも `sessionGeneration` が進むため、世代の比較で捨てられる
- `start()` が捕捉する `startGeneration` を、`connectToServer` の `onSessionGoaway` の閉包と、次のリクエストストリームの `goaway` コールバックに渡す
  - subscriber: `CatalogSubscription.subscribe` の catalog SUBSCRIBE / FETCH の `goaway`、`subscribeMediaTracks` の音声・映像の `SubscribeCallbacks.goaway`
  - publisher: `announceNamespace` の `NamespacePublicationCallbacks.goaway`、`createPublishers` の catalog / 音声 / 映像の `PublishCallbacks.goaway`
  - `createPublishers` は現在 `startGeneration` を受け取っていないため `start()` から渡し、`CatalogSubscription.subscribe` は受け取っている `startGeneration` を `reportGoaway` に渡す
- 捨てた通知の debug 記録は行わない。高レベル API には debug コールバックが無く、低レベルの `namespaceNotifyError` はアプリコールバックの例外を記録するもので、通知の抑止の記録とは目的が異なる
- `docs/HIGH_LEVEL_API.md` の「GOAWAY の扱い」と `src/codec/types.ts` の `MediaSubscriberCallbacks.onGoaway` / `MediaPublisherCallbacks.onGoaway` の JSDoc に、`close()` / `stop()` / ピア起点の close の解放開始後 (解放中および完了後) と旧世代の GOAWAY は `onGoaway` に通知しないことを明記する
- 低レベルの制御ループ (`sessionStartControlMessageLoop`) は変更しない。close 中に読めた GOAWAY が `ConnectCallbacks.goaway` に届くことは許容し、高レベル側の `notifyGoaway` の入口で捨てる

## 完了条件

- `close()` / `stop()` / ピア起点の close の解放開始後 (解放中および完了後) と旧世代の GOAWAY が `onGoaway` に届かない
- 現行の接続での GOAWAY の通知と抑止は変わらない
- Session の制御ストリームとリクエストストリームの両方で、上記をテストで固定する
- docs と JSDoc が実装と一致する
- `vp check` / `vp run typecheck` / `vp test --run` が通る

`CHANGES.md` は MOQT RFC ドラフト中のため更新しない (`CODEBASE.md` の特別ルール)。

## 参照

- `src/createMediaSubscriber.ts` / `src/createMediaPublisher.ts` の `notifyGoaway` / `connectToServer` / `handleSessionClose` / `disposeAllResources` / `sessionGeneration`
- `src/createMediaSubscriber.ts` の `subscribeMediaTracks`、`src/createMediaPublisher.ts` の `createPublishers` / `announceNamespace`
- `src/mediaSubscriber/catalogSubscription.ts` の `subscribe` / `reportGoaway`
- `src/session/lifecycle.ts` の `sessionStartControlMessageLoop` と `sessionHandleGoaway`
- `docs/HIGH_LEVEL_API.md` の「GOAWAY の扱い」
- `src/codec/types.ts` の `MediaSubscriberCallbacks.onGoaway` / `MediaPublisherCallbacks.onGoaway`
- `src/session/publicTypes.ts` の `ConnectCallbacks.goaway` (低レベル API の契約は変えない)
- `src/createMediaPublisher.test.ts` / `src/createMediaSubscriber.lifecycle.test.ts` の `createStartConnectHarness`
- `issues/0942-refactor-goaway-notifier.md` (notifyGoaway の共通化。共通化する場合は状態 / 世代の判定を渡す形にする)
- `issues/0943-change-ongaway-source.md` (docs / JSDoc の由来の契約。文言を揃える)
- `issues/0941-test-high-level-goaway-wiring.md` (音声・映像の SUBSCRIBE と catalog の FETCH の GOAWAY を駆動するハーネス)
- `issues/closed/0929-bug-media-publisher-error-generation-guard.md` (onSessionError の世代ガード。判定の書き方を揃える)
