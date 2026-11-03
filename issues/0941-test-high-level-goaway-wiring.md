# 音声・映像の SUBSCRIBE と catalog の FETCH の高レベル GOAWAY 配線が未テスト

- Created: 2026-11-03
- Completed: {YYYY-MM-DD}
- Branch: feature/test-high-level-goaway-wiring
- Polished: {YYYY-MM-DD}

## 目的

0891 で高レベル API に `onGoaway` を追加し、subscriber は catalog / 音声 / 映像の SUBSCRIBE と catalog の FETCH、publisher は catalog / 音声 / 映像の PUBLISH の GOAWAY を通知するようにした。しかし高レベルのテストで固定できているのは catalog の SUBSCRIBE、PUBLISH_NAMESPACE、catalog の PUBLISH だけで、音声・映像の SUBSCRIBE と catalog の FETCH の配線は未固定である。配線を削除してもテストが通る。

## 現状

- `src/createMediaSubscriber.ts` の `subscribeMediaTracks` は音声 / 映像の `SubscribeCallbacks.goaway` に `notifyGoaway` を渡す
- `src/mediaSubscriber/catalogSubscription.ts` は catalog の SUBSCRIBE と FETCH の `goaway` に `reportGoaway` を渡す
- `src/createMediaSubscriber.lifecycle.test.ts` の `createStartConnectHarness` は `holdSubscribe` で catalog の SUBSCRIBE を保留し、`fetch` は必ず throw する。そのため音声・映像の SUBSCRIBE と FETCH まで進まない
- `session.subscribe` の callbacks は 1 変数で上書きするため、最後の購読しか捕捉できない

## 設計方針

ハーネスを拡張し、音声・映像の SUBSCRIBE と catalog の FETCH の `goaway` を駆動できるようにする。

- `subscribe` の callbacks を track 名ごとに保持し、テストから track を指定して `goaway` を呼べるようにする
- `fetch` を成功させ、`FetchCallbacks.goaway` を捕捉する。catalog の FETCH は `SUBSCRIBE_OK` の後に始まるため、`start()` の完了を待ってから駆動する
- 音声・映像は `MediaSubscriberOptions` に `audio` / `video` を指定して `start()` を完了させる (catalog の fetch が成功するハーネスが前提)
- 各配線を削除するとテストが落ちることを確認する

## 完了条件

- 音声・映像の SUBSCRIBE の GOAWAY で `onGoaway` が呼ばれることをテストで固定する
- catalog の FETCH の GOAWAY で `onGoaway` が呼ばれることをテストで固定する
- 各配線を削除するとテストが落ちる (変異検出できる)
- `vp check` と `vp test --run` が通る

`CHANGES.md` は MOQT RFC ドラフト中のため更新しない (`CODEBASE.md` の特別ルール)。テストのみの変更のため `### misc` にも記載しない。

## 参照

- `src/createMediaSubscriber.ts` の `subscribeMediaTracks`
- `src/mediaSubscriber/catalogSubscription.ts` の `subscribe` (SUBSCRIBE と FETCH)
- `src/createMediaSubscriber.lifecycle.test.ts` の `createStartConnectHarness`
- `issues/closed/0891-add-high-level-goaway-migration.md` の解決方法 (未固定の旨)
