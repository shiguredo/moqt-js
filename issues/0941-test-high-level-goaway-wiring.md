# 音声・映像の SUBSCRIBE / PUBLISH と catalog の FETCH の高レベル GOAWAY 配線が未テスト

- Created: 2026-11-03
- Completed: {YYYY-MM-DD}
- Branch: feature/test-high-level-goaway-wiring
- Polished: 2026-11-15

## 目的

0891 で高レベル API に `onGoaway` を追加し、subscriber は catalog / 音声 / 映像の SUBSCRIBE と catalog の FETCH、publisher は catalog / 音声 / 映像の PUBLISH の GOAWAY を通知するようにした。しかし高レベルのテストで駆動しているのは catalog の SUBSCRIBE、PUBLISH_NAMESPACE、catalog の PUBLISH だけであり、音声・映像の SUBSCRIBE、catalog の FETCH、音声・映像の PUBLISH の配線は未固定である。これらの配線を削除してもテストが通る。

## 現状

- `src/createMediaSubscriber.ts` の `subscribeMediaTracks` は音声 / 映像の `SubscribeCallbacks.goaway` に `notifyGoaway` を渡す
- `src/mediaSubscriber/catalogSubscription.ts` は catalog の SUBSCRIBE と FETCH の `goaway` に `reportGoaway` を渡す
- `src/createMediaPublisher.ts` の `createPublishers` は catalog / 音声 / 映像の `PublishCallbacks.goaway` に `notifyGoaway` を渡す
- `src/createMediaSubscriber.lifecycle.test.ts` の `createStartConnectHarness` は `holdSubscribe` で catalog の SUBSCRIBE を保留し、`fetch` は必ず throw する。そのため音声・映像の SUBSCRIBE と FETCH まで進まない。start() の成功パスは node 環境には `MediaStream` / `AudioContext` / WebCodecs が無いため駆動していない
- `session.subscribe` の callbacks は 1 変数で上書きするため、最後の購読しか捕捉できない
- `src/createMediaPublisher.test.ts` の `createStartConnectHarness` は `publishCallbacks` を track 名ごとに保持し、`notifyPublishGoaway(trackName, ...)` を持つが、テストで駆動しているのは catalog の PUBLISH だけである

## 設計方針

ハーネスを拡張し、音声・映像の SUBSCRIBE、catalog の FETCH、音声・映像の PUBLISH の `goaway` を駆動できるようにする。

- `subscribe` の callbacks を track 名ごとに保持し、テストから track を指定して `goaway` を呼べるようにする。既存の `notifySubscribeGoaway` の呼び出しは catalog の track 名を渡す形に更新する
- `fetch` を成功させ、`FetchCallbacks.goaway` を捕捉する。fetch はフル catalog を `object` で配信して `end` を呼び、catalog の受信待ちを解決する。catalog の FETCH は `SUBSCRIBE_OK` の後に始まるため、`start()` の完了を待ってから駆動する
- ハーネスに `MediaSubscriberOptions` を渡せるようにし、音声・映像は `audio` / `video` を指定して catalog に音声と映像の track を含めて `start()` を完了させる。node 環境には `MediaStream` / `AudioContext` / WebCodecs が無いため、ハーネスで `createOutputStream` と `setupDecoders` を no-op に差し替える (`openSession` と同じくブラウザ API の境界だけを置き換える)
- publisher は `MediaPublisherOptions` に音声または映像を指定し、`useWorker: false` と既存の `createAudioMediaStream` / `createVideoMediaStream` を使って `start()` を完了させる。node 環境には `AudioEncoder` / `VideoEncoder` / `MediaStreamTrackProcessor` も無いため、既存の `replaceAudioCodecBoundary` / `replaceVideoCodecBoundary` で WebCodecs の境界を置き換える。`notifyPublishGoaway` を音声 / 映像の track 名で駆動する (音声と映像は別々のテストにする)
- `fetch` を成功させる変更で、既存の `GOAWAY: onGoaway が Session と購読の GOAWAY の URI を受け取る` テストは start が失敗する前提を変える必要がある。fetch の成功で start が完了する前提に更新する
- 各配線を削除するとテストが落ちることを確認する

## 完了条件

- 音声・映像の SUBSCRIBE の GOAWAY で `onGoaway` が呼ばれることをテストで固定する
- catalog の FETCH の GOAWAY で `onGoaway` が呼ばれることをテストで固定する
- 音声・映像の PUBLISH の GOAWAY で `onGoaway` が呼ばれることをテストで固定する
- 各配線を削除するとテストが落ちる (変異検出できる)
- 既存の GOAWAY テストを新しいハーネスの前提 (fetch の成功と track 名付きの `notifySubscribeGoaway`) に合わせる
- `vp check` と `vp test --run` が通る

`CHANGES.md` は MOQT RFC ドラフト中のため更新しない (`CODEBASE.md` の特別ルール)。テストのみの変更のため `### misc` にも記載しない。

## 参照

- `src/createMediaSubscriber.ts` の `subscribeMediaTracks`
- `src/mediaSubscriber/catalogSubscription.ts` の `subscribe` (SUBSCRIBE と FETCH)
- `src/createMediaPublisher.ts` の `createPublishers`
- `src/createMediaSubscriber.lifecycle.test.ts` の `createStartConnectHarness`
- `src/createMediaPublisher.test.ts` の `createStartConnectHarness` / `notifyPublishGoaway` / `replaceAudioCodecBoundary` / `replaceVideoCodecBoundary`
- `src/session/publicTypes.ts` の `SubscribeCallbacks.goaway` / `FetchCallbacks.goaway` / `PublishCallbacks.goaway`
- `src/codec/types.ts` の `MediaSubscriberCallbacks.onGoaway` / `MediaPublisherCallbacks.onGoaway`
- `issues/closed/0891-add-high-level-goaway-migration.md` の解決方法 (未固定の旨)
