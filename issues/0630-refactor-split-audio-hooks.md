# devtools の音声の配信と購読の経路をフックへ分離する

- Created: 2026-09-20
- Completed: {YYYY-MM-DD}
- Branch: feature/refactor-split-audio-hooks
- Polished: 2026-11-14
- Refreshed: 2026-11-09

## 目的

devtools に音声の配信と購読を追加した結果、`devtools/src/hooks/usePublisher.ts` と `devtools/src/hooks/useSubscriber.ts` が映像と音声の両方を 1 ファイルで扱うようになり、どちらも 1000 行を超えた。issue 作成時点 (2026-09-20) は 1141 行 / 1233 行であり、本 issue の磨き上げ時点 (2026-11-14) は 2450 行 / 3729 行である。音声は次の点で映像と独立した構造を持つため、同じファイルに置く必然性が無い。

- Group 採番: draft-ietf-moq-loc-05 §4.1 により音声は chunk 1 つごとに Group を進める (映像はキーフレームで進める)
- publish / subscribe: 音声は映像とは別の `session.publish` と `session.subscribe` を持つ
- 優先度: 音声は `PRIORITY_AUDIO` を使う
- 再生: 音声だけが AudioContext を持ち、AudioContext の destination へ直接出力する (`<audio>` 要素は使わない)

分離して見通しを戻し、以後の変更 (可視化・統計・相互運用の追加) が映像側と干渉しないようにする。

## 現状

- `devtools/src/hooks/usePublisher.ts` に映像の配信経路と音声の配信経路 (`startAudioStream` / `prepareAudioForPublishing` / `takeAudioFrameSourceForPublishing` / `startPreviewAudio` / `stopAudioStream` / `processAudioFrames` / `startAudioPublishing` / `handleAudioEncodedChunk` / `resolveAudioConfigToSend` / `resolveAudioPublishable` / `buildAudioSendCopyPlan` / `recordAudioDatagramSent`) が同居する。音声レベルの時刻解決は `devtools/src/utils/audioLevelTimeline.ts` の `AudioLevelTimeline#levelFor` が担い、`usePublisher.ts` は記録と `levelFor` の呼び出しを行う
- `devtools/src/hooks/usePublisher.ts` の `resolveAudioConfigToSend` は `src/createMediaPublisher.ts` が export している同名関数 (パッケージ公開 API ではない) と同じ判定 (直前と違う description なら載せ、送り直し要求には保持値で応える) を再実装している。ライブラリ側は `description.length > 0` のガードを持つ点だけが異なる
- `devtools/src/hooks/useSubscriber.ts` に映像の購読経路と音声の購読経路 (`startAudioSubscription` / `subscribeAudioOnly` / `handleAudioObject` / `handleAudioDecoded`) が同居する。再生の開始と停止は `devtools/src/hooks/audioPlaybackController.ts`、停止時の drain は `devtools/src/hooks/subscriberAudioStop.ts`、開始と停止の判定は `devtools/src/hooks/audioPlaybackLifecycle.ts`、復号前遅延は `devtools/src/hooks/subscriberPreDecodeDelay.ts` に切り出し済みで、`useSubscriber.ts` には結線と呼び出しが残る
- signal は既に `devtools/src/signals/publisher.ts` / `devtools/src/signals/subscriber.ts` に分かれており、フックだけが混在している
- `devtools/src/signals/subscriber.ts` の `removeSubscriber` と `useSubscriber.ts` の `closeSubscriberResources` は、どちらも `devtools/src/utils/subscriberResourceRelease.ts` の `releaseSubscriberResources` を呼び、後始末の順序は 1 箇所に集約済みである (映像 decoder → 音声 decoder → catalog 購読 → 音声トラック購読 → event timeline 購読 → SUBSCRIBE_TRACKS 購読 → 確立した PUBLISH 購読 → session)。本 issue ではこの 1 箇所を分割後も維持する
- `issues/0828-refactor-share-playout-paths.md` の第 3 段 (購読そのもの) と第 4 段 (devtools の音声 Object の経路) は、音声の購読経路をライブラリの共有実装へ寄せる。第 3 段のうち catalog の購読は `src/mediaSubscriber/catalogSubscription.ts` の `CatalogSubscription` としてライブラリ側に先行実装済みだが、devtools の `startSubscribing` はまだ自前で組み立てている。音声と映像の SUBSCRIBE の発行は `src/mediaSubscriber/trackSubscriptions.ts` の `subscribeTrack` に寄っており、devtools に残るのは購読のコールバック・世代管理・停止である。本 issue は 0828 の完了を待たずに devtools のフック分割を先に行う。0828 が先に完了した場合は、その変更を含む `useSubscriber.ts` を分割する。0828 が後になる場合は、共有実装への移設は分割後のファイルを対象にする
- `issues/0830-refactor-devtools-audio-delivery.md` は `devtools/src/types.ts` の `AudioDelivery` と、`devtools/src/utils/audioDelivery.ts` の `shouldSendAudioAsDatagram`、`usePublisher.ts` の `buildAudioSendCopyPlan` / `loggedAudioDatagramFallback` を変更対象にする。本 issue が切り出す音声配信経路と範囲が重なる。どちらが先に実施されても、`buildAudioSendCopyPlan` / `loggedAudioDatagramFallback` は分割後の `useAudioPublisher.ts` を対象にする (本 issue が先なら 0830 が `useAudioPublisher.ts` を変更し、0830 が先なら本 issue がその変更を含めて分割する)。`shouldSendAudioAsDatagram` は `devtools/src/utils/audioDelivery.ts` のままである

## 設計方針

- 分離の際に、Audio Config の送出判断はライブラリの `src/createMediaPublisher.ts` が export している `resolveAudioConfigToSend` を import して使う (devtools 側の再実装を削除する)。`isSameCodecDescription` はライブラリが export しておらず、購読側の判断 (`useSubscriber.ts`) でも使うため `devtools/src/utils/codec.ts` に残す (音声の送出判断からは不要になる)。判定の差分 (`description.length > 0` のガード) はライブラリ側の挙動に揃える。devtools は既に `selectCodecDescription` を `src/createMediaPublisher.ts` から import して呼んでいるため、ライブラリの `resolveAudioConfigToSend` へ乗り換えると空の description の扱いもライブラリ側に揃う。devtools の `resolveAudioConfigToSend` を削除すると `devtools/src/hooks/usePublisher.test.ts` の同名のテストが参照できなくなるため、そのテストは削除する (同じ契約は `src/createMediaPublisher.test.ts` と `src/createMediaPublisher.prop.ts` が固定している)

- 音声の配信経路を `devtools/src/hooks/useAudioPublisher.ts`、音声の購読経路を `devtools/src/hooks/useAudioSubscriber.ts` へ切り出す。既存の音声専用モジュール (`audioPlaybackController.ts` / `audioPlaybackLifecycle.ts` / `publisherAudioMeter.ts` / `subscriberAudioStop.ts`) は `devtools/src/hooks/` 直下にフラットに置かれており、`audio/` 配下は存在しないため、新しい 2 ファイルも同じ階層に置く。音声固有の純関数 (`resolveAudioPublishable` / `buildAudioSendCopyPlan` / `recordAudioDatagramSent`) も `useAudioPublisher.ts` へ移す。購読側の `resolveAudioTrack` は catalog から音声トラックを選ぶ helper であり、`useSubscriber.ts` に残す
- 後始末の順序は `devtools/src/utils/subscriberResourceRelease.ts` の `releaseSubscriberResources` に既に集約済みである。本 issue では分割後もこの 1 箇所を維持し、音声の購読経路を切り出す際に解除の順序を分散させない
- signal の置き場と名前は変えない (切り出しの差分を機械的にするため)
- 振る舞いを変えない。テストと E2E は移設に伴う import の更新と、削除する `resolveAudioConfigToSend` の devtools 側テストの削除だけを行い、残りのテストが通ることを確認する

## 完了条件

- `usePublisher` / `useSubscriber` のフック本体から音声の経路 (状態・signal・イベント結線) が無くなり、音声の経路が `useAudioPublisher.ts` / `useAudioSubscriber.ts` に移っている。行数は音声の経路を切り出した分だけ減る (音声追加前の 1141 行 / 1233 行は目安であり、その他の機能追加の分は残る)
- 後始末の順序が `releaseSubscriberResources` の 1 箇所で表現されたままである
- `vp check` / `vp test run` / `vp run e2e-test` が通る (振る舞いを変えない)

## 参照

- draft-ietf-moq-loc-05 §4.1 (Application with one audio track: 音声は 1 chunk = 1 Object = 1 Group)
- draft-ietf-moq-msf-01 §5.2.6 (Track role) / §6.1 (Group numbering)

## 解決方法

{未着手}
