# moqt-devtools の subscriber の Stop で、エラーのログが出る

- Created: 2026-09-25
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-devtools-subscriber-stop-error-logs
- Polished: 2026-11-14
- Refreshed: 2026-11-14

## 目的

moqt-devtools の subscriber で Stop を押すと、自分から止めただけなのに、デバッグログに「webtransport error」が 2〜3 回と「DATAGRAM_LOOP_ERROR」が出る (2026-09-25 の実測)。本当のエラーと見分けがつかず、切り分けの邪魔になる。

## 現状

- 実測 (2026-09-25、手元の sora-moq の relay): 購読してから Stop を押すと、デバッグログに `[subscriber-...] webtransport error` が 2 回 (映像と音声の配信では 3 回)、`[subscriber-...] [RECV] DATAGRAM_LOOP_ERROR` が 1 回、`webtransport closed` が 1 回出る。映像だけ、音声だけのどちらでも出る
- 2026-09-25 の実測は、後始末を共有実装へ寄せた変更 (open の `0828-refactor-share-playout-paths.md` の実装) と、SUBSCRIBE_TRACKS の購読を足した変更 (closed の `0956-add-devtools-subscribe-tracks.md` / `0957-add-devtools-publish-playback.md`) より前のものである。現在の経路で再測する
- Stop の後始末は `devtools/src/hooks/useSubscriber.ts` の `stopSubscribing` から `teardownSubscriber` / `closeSubscriberResources` を経て、`devtools/src/utils/subscriberResourceRelease.ts` の `releaseSubscriberResources` に至る。購読の解除の後に `session.close()` を呼ぶ
- `src/session/dataStreamIncoming.ts` の `dataStreamStartDatagramLoop` は、datagram の読み出しで例外が出ると `DATAGRAM_LOOP_ERROR` の debug を出し、`notifyErrorIfActive` を呼ぶ。debug は session の状態を見ずに無条件で出すため、`sessionNotifyErrorIfActive` が `callbacks.error` を呼ばない場合でも DebugPanel には残る。session を閉じたときの読み出しが例外で終わる場合も、この経路を通るとみている
- catch で `notifyErrorIfActive` を呼ぶ経路はほかにもあり、`src/session/dataStreamIncoming.ts` の `dataStreamStartIncomingStreamLoop` (無条件の `STREAM_LOOP_ERROR` の debug 付き) と `src/session/incomingPublish.ts` の `incomingPublishStartBidiStreamLoop` / `incomingPublishReadFirstBidiMessage` である
- `src/session/lifecycle.ts` の `sessionNotifyErrorIfActive` は、`sessionState` が `"connected"` でないときとセッション終了起源のエラーでは `callbacks.error` を呼ばず、`sessionClose` は transport を閉じる前に `sessionState` を `"closed"` にする。そのため transport を閉じた後の読み出しエラーは `callbacks.error` に届かない。`webtransport error` が出るとすれば、`sessionClose` より前の経路 (購読の解除など) か、`sessionCloseWithError` を呼ぶ経路 (プロトコル違反、データストリームの途中終了など) である。どの経路で出たのかはコードからは特定できていない
- `devtools/src/hooks/useSubscriber.ts` の `startSubscribing` は、`connect` の `error` コールバックで「webtransport error」のログを出す。このログは `createAttemptGuard` の判定より前に出すため、停止した購読の error でも DebugPanel に残る

## 再現手順

1. sora-moq の relay に接続し、Subscriber で購読を始める (映像だけ、音声だけ、両方の 3 通り)
2. 購読が確立したら Stop を押す
3. DebugPanel に `webtransport error` (2〜3 回) と `DATAGRAM_LOOP_ERROR` (1 回)、`webtransport closed` (1 回) が出る (2026-09-25 の実測)
4. relay を止めるなど、Stop を押さずにセッションが切れた場合は、`webtransport closed` と statusMessage が出て、`webtransport error` は出ないことも確かめる

## 設計方針

- 自分から session を閉じたときに、どの経路が例外を出し、なぜ `error` コールバックまで届くのかを確かめる
- Stop を押してから後始末が終わるまでの間に起きた、自分から閉じたことによる終わりは、エラーとして通知しない。エラー系の debug (`DATAGRAM_LOOP_ERROR` / `STREAM_LOOP_ERROR` など) も出さない。なお `webtransport closed` の warn は停止中でも DebugPanel に残す既存設計 (close / error コールバック先頭の addLog) のため対象外とする
- debug は `dataStreamStartDatagramLoop` / `dataStreamStartIncomingStreamLoop` が session の状態を見ずに無条件で出している。自分から閉じたときは、session の状態を見て debug を出さないか、devtools 側で停止中の debug を落とす
- 自分から閉じた以外の理由による本当のエラーは今と同じく通知する

## 完了条件

- Stop で「webtransport error」と、エラー系の debug (`DATAGRAM_LOOP_ERROR` / `STREAM_LOOP_ERROR` など) が出ない
- relay を止めるなど、自分から閉じていないのに本当に切れたときは、今と同じく通知される (peer 起点のセッション終了は現行どおり `callbacks.close` 経由の `webtransport closed` と statusMessage になり、`callbacks.error` は呼ばれない)。自分から閉じた以外の理由のエラーは、今と同じく `webtransport error` で通知する
- Stop で `webtransport error` と `DATAGRAM_LOOP_ERROR` が出ないことをテストで固定する。既存の Playwright の E2E はこれらのログを検査していないため、単体テストか E2E を足す
- `CHANGES.md` は `CODEBASE.md` の「MOQT RFC ドラフト中の特別ルール」に従い変更しない
- `vp check` / `tsc --noEmit` / `vp test run` / 既存の Playwright の E2E が通る

## 参照

- `devtools/src/hooks/useSubscriber.ts` の `startSubscribing` / `stopSubscribing` / `teardownSubscriber` / `closeSubscriberResources`
- `devtools/src/utils/subscriberResourceRelease.ts` の `releaseSubscriberResources`
- `devtools/src/hooks/debugMessageLog.ts` の `logDebugMessage` (debug の表示経路)
- `src/session/dataStreamIncoming.ts` の `dataStreamStartDatagramLoop` / `dataStreamStartIncomingStreamLoop`
- `src/session/incomingPublish.ts` の `incomingPublishStartBidiStreamLoop` / `incomingPublishReadFirstBidiMessage`
- `src/session/lifecycle.ts` の `sessionNotifyErrorIfActive` / `sessionClose`
- `src/session.ts` の `transport.closed` の処理 (close コールバック)
- `tests/e2e` の Stop の既存テスト (`devtools-both-audio.spec.ts` など) と DebugPanel のテスト (`devtools-debug-panel.spec.ts`)
- closed の `0176-fix-route-webtransport-close-error-through-add-log.md` (ログの追加元)
- open の `0828-refactor-share-playout-paths.md` (後始末の共有実装)
- closed の `0956-add-devtools-subscribe-tracks.md` / `0957-add-devtools-publish-playback.md` (Stop で解除する購読が増えた)

## 解決方法

{未着手}
