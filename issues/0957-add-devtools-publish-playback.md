# devtools で SUBSCRIBE_TRACKS の PUBLISH から確立した購読を再生に載せる

- Created: 2026-11-13
- Completed: 2026-11-13
- Branch: feature/add-devtools-publish-playback
- Polished: 2026-11-13

## 目的

publisher を停止して再開すると、catalog 経由の `SUBSCRIBE` は `PUBLISH_DONE` で終了したまま戻らない。`SUBSCRIBE_TRACKS` を送っていれば再開後の `PUBLISH` で購読が確立し直されるが、devtools はその Object を数えるだけで再生に載せていないため、映像も音声も戻らない。再開後に `SUBSCRIBE_TRACKS` の購読で受信した Object を既存の再生経路へ流し、表示と再生を戻す。

## 現状

- `createTracksSubscriptionCallbacks` の `onPublish` は、catalog で購読済みの Track と一致する `PUBLISH` の Object を `duplicate` として捨てる。一致しない `PUBLISH` の Object も `publishedObjectsReceived` に数えるだけである
- `handleTrackEnd` は `PUBLISH_DONE` を受けた Track を「終了」にするが、再購読しない
- したがって publisher の再開後、devtools の表示は終了したままになる

## 設計方針

- `SubscriberInstance` に `publishedVideoHandler` / `publishedAudioHandler` / `publishedVideoResume` を追加する。購読の開始時に、既存のデコーダーと再生の経路へ Object を渡す関数を設定し、`resetSubscriberState` で null に戻す
- `subscribedTrackNamesForTracksSubscription` は Track Name だけでなく種別 (`video` / `audio` / `other`) を返す。PUBLISH の Object を再生に載せるかの判定に使う
- `onPublish` は、一致する `PUBLISH` の Track が映像または音声で、かつ catalog 経由の購読が既に終了している場合にだけ、Object を `publishedVideoHandler` / `publishedAudioHandler` へ流す。catalog の購読が生きている間は、同じ Object を 2 回復号しないよう捨てる
- 映像は publisher の再開で Group が巻き戻るため、最初の Object を流す前に `publishedVideoResume` で復号の順序と Group の保留をリセットし、キーフレームから復号し直す
- 映像の Object 処理を `enqueueVideoObject` として切り出し、`SUBSCRIBE` のコールバックと `PUBLISH` の経路で同じ処理を使う
- 再生に載せた Object も `publishedObjectsReceived` に数える

## 完了条件

- publisher の停止 → 再開で、`SUBSCRIBE_TRACKS` の `PUBLISH` から確立した購読の Object が既存の映像・音声の経路へ流れる
- catalog の購読が生きている間は `duplicate` として捨て、二重に復号しない
- 映像は復帰時に復号の順序をリセットしてキーフレームから復号する
- 上記の判定と転送を単体テストで固定する
- `vp check` / `tsc --noEmit` / `vp test run` が通る

## 解決方法

- `SubscriberInstance` に `publishedVideoHandler` / `publishedAudioHandler` / `publishedVideoResume` を追加した。購読の開始時に設定し、`resetSubscriberState` で null に戻す
- `subscribedTrackNamesForTracksSubscription` が `SubscribedTrackEntry` (Track Name と種別) を返すようにした
- `createTracksSubscriptionCallbacks` は、一致する `PUBLISH` の Track が映像または音声で、catalog 経由の購読が終了している場合に限り、Object を既存の再生経路へ流す。catalog の購読が生きている間は `duplicate` として捨てる
- 映像は `publishedVideoResume` で `VideoDecodeOrder` と Group の保留をリセットし、キーフレームから復号し直す。リセットは購読ごとに最初の Object で 1 回だけ行う
- 映像の Object 処理を `enqueueVideoObject` に切り出し、`SUBSCRIBE` と `PUBLISH` の両方から呼ぶ
- テストを 2 件追加した (終了後に PUBLISH の Object が再生へ流れること・復帰のリセットが 1 回だけであること、購読が生きている間は捨てること)
- 検証: `vp check` / `vp exec tsc --noEmit` / `vp test run` (277 ファイル、5174 テスト) が通る
