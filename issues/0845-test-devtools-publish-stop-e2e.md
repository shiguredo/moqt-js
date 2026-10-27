# devtools の publish 停止で購読が維持されることを実リレーで固定する e2e が無い

- Created: 2026-10-13
- Completed: {YYYY-MM-DD}
- Branch: feature/add-devtools-publish-stop-e2e
- Polished: 2026-10-27

## 目的

moqt-devtools は、購読しているトラックが PUBLISH_DONE で終わっても購読とセッションを維持するようになった (closed 0839)。しかし、devtools の SubscriberPanel を通して「publisher を停止 → subscriber のセッションと購読が維持される」経路を実リレーで固定する e2e が無い。単体テストはフックの外へ切り出した `handleTrackEnd` までで、`startSubscribing` の `end` クロージャ (後始末しない配線) を通せない。配線が戻ると、0839 が直した不具合 (最後のフレームを失う / トラック 1 本の終了を配信の終了と誤認する) が再発する。

実リレー接続用テストページの購読者 (`window.__moqtE2E`) では、`tests/e2e/relay/devtools-publish-stop.spec.ts` が publisher 停止後の `state === "active"` を固定している。しかし、この spec は `close-session` と `stop-sending` の 2 つの止め方だけを観測し、既定の `publish-done` (PUBLISH_DONE を送る) を観測していない。また購読者は devtools の SubscriberPanel ではない。したがって、PUBLISH_DONE を受けた devtools の SubscriberPanel の状態は e2e で固定されていない。

## 現状

- `publisher-stop-button` を押す spec は `tests/e2e/relay/` に複数あるが、いずれも devtools の SubscriberPanel の状態を publisher 停止後に assert していない
  - `tests/e2e/relay/devtools-publish-stop.spec.ts` は devtools の publisher を停止し、実リレー接続用テストページの購読者 (`window.__moqtE2E`) の状態としては `state` を `active` と assert するだけである。止め方は `close-session` と `stop-sending` だけで、既定の `publish-done` は観測しない
  - `tests/e2e/relay/audio-catch-up.spec.ts` は devtools の publisher と subscriber を同じページで動かすが、publisher の停止はテストの最後の後始末にだけ使い、停止後の購読状態を assert していない
- `tests/e2e/relay/devtools-both-audio.spec.ts` にも devtools の publisher と subscriber を同じページで動かすテストがあるが、publisher の停止を押さない
- `tests/e2e/` 直下の spec には `publisher-stop-button` を押すテストが無い
- 実リレーへ接続する spec は `relay` project で、`TEST_MOQT_URI` が設定された環境でだけ実行される (`npx vp run e2e-test:relay`)

## 設計方針

- `relay` project に新しい spec (`tests/e2e/relay/devtools-subscriber-publish-stop.spec.ts`) を追加する。既存の `tests/e2e/relay/devtools-publish-stop.spec.ts` は実リレー接続用テストページの購読者を見る spec であり、止め方ごとのその購読者の観測に絞る (拡張しない)
- devtools の publisher と subscriber を同じページで動かす (`tests/e2e/relay/audio-catch-up.spec.ts` と同じ形)。namespace は `formatTrackNamespace(createTestNamespace())` で一意にする
- publisher を停止する前に、subscriber の購読が確立し、`subscriber-video-canvas` に背景色以外の画素が描かれるまで待つ。映像のフレームが 1 枚も描かれていないと、最後のフレームの判定ができない
- publisher の止め方は既定の `publish-done` にする (`devtools/src/signals/connectionSettings.ts` の `publishStop` の既定、`devtools/src/hooks/usePublisher.ts` の `buildPublishStopPlan`)。`publish-done` は各トラックに PUBLISH_DONE (TRACK_ENDED) を送ってからセッションを閉じる。`close-session` / `stop-sending` は PUBLISH_DONE を送らないため、Status の文言を固定できない
- publisher を停止した後、subscriber 側で次を固定する
  - `subscriber-status-message` が `video ended: TRACK_ENDED (0x2)` を含む。音声も購読しているため、実際の文言は `audio ended: ...` と `video ended: ...` の両方を含みうる。`toContainText` で判定する。devtools の publisher は Reason Phrase を空で送る (`src/session/publish.ts` の `publishSendPublishDoneCore` が Reason Phrase Length に 0 を書く) ため、Reason Phrase の文言は要求しない
  - `subscriber-stop-button` が押せる (`toBeEnabled()`。購読とセッションが維持されている)。`devtools/src/signals/subscriber.ts` の `hasEstablishedSubscription` と `devtools/src/utils/subscriberControls.ts` の `subscriberControlState` が、購読が維持されていれば Stop を押せる状態にする
  - `subscriber-video-canvas` に最後のフレームが残る。canvas の画素を `getImageData` で読み、背景色 (#1e293b) 以外の画素が残ることを assert する。`devtools/src/hooks/useSubscriber.ts` の `closeSubscriberResources` は後始末で canvas を背景色で塗るため、単に「空でない」では後始末を見逃す
- 検証の後は subscriber の Stop を押して購読を止め、ページを閉じる。publisher は検証の途中で停止済みである
- `TEST_MOQT_URI` が無い環境では skip する (`tests/e2e/relay/support.ts` の `requireRelayUri` を使う)
- 対象外: ライブラリ (`createMediaSubscriber`) の購読終了の扱い (0839 の前提であり、本 issue では変更しない)、relay 側の実装

## 完了条件

- `npx vp run e2e-test:relay` で新しい spec が通る (`TEST_MOQT_URI` 未設定の環境では skip する)
- publisher を停止する前に、subscriber の `subscriber-video-canvas` に映像のフレームが描かれていることを確認している
- publisher の停止後に、`subscriber-status-message` が `video ended: TRACK_ENDED (0x2)` を含むことを assert している
- publisher の停止後に、`subscriber-stop-button` が押せること (購読とセッションが維持されていること) を assert している
- publisher の停止後に、`subscriber-video-canvas` に背景色 (#1e293b) 以外の画素が残ることを assert している
- 検証の後は subscriber の Stop を押して購読を止め、ページを閉じている
- `npx vp check` / `npx vp test --run` が通る

## 参照

- closed の `0839-bug-devtools-track-end-teardown.md` (トラック終了で購読とセッションを維持する)
- closed の `0840-change-subscriber-publish-done-reason.md` (PUBLISH_DONE の status code と reason を終了通知に載せる)
- closed の `0841-add-devtools-publish-stop-variants.md` (publish 停止の止め方)
- `tests/e2e/relay/devtools-publish-stop.spec.ts` (既存の publisher 停止の spec。購読者は実リレー接続用テストページ)
- `tests/e2e/relay/audio-catch-up.spec.ts` (devtools の publisher と subscriber を同じページで動かす先例)
- `tests/e2e/relay/support.ts` (`requireRelayUri` / `createTestNamespace` / `RELAY_TEST_TIMEOUT_MS`)
- `src/fullTrackName.ts` の `formatTrackNamespace`
- `tests/e2e/urls.ts` (`DEVTOOLS_URL`)
- `playwright.config.ts` (`relay` project)
- `devtools/src/hooks/useSubscriber.ts` の `handleTrackEnd` / `startSubscribing` の `end` クロージャ / `closeSubscriberResources`
- `devtools/src/components/SubscriberPanel.tsx` の `subscriber-status-message` / `subscriber-stop-button` / `subscriber-video-canvas`
- `devtools/src/utils/subscriberControls.ts` の `subscriberControlState`
- `devtools/src/signals/subscriber.ts` の `hasEstablishedSubscription`
- `devtools/src/hooks/usePublisher.ts` の `buildPublishStopPlan` / `stopPublishing`
- `devtools/src/signals/connectionSettings.ts` の `publishStop`
- `devtools/src/utils/playoutTimingStats.ts` の `formatPublishDoneStatusCode`
- `src/publisher.ts` の `PublisherImpl.done`
- `src/session/publish.ts` の `publishSendPublishDoneCore`
- `tests/e2e/devtools-audio-meter.spec.ts` (canvas の画素を読む先例)

## 解決方法

{未着手}
