# devtools の音声の配信と購読の経路をフックへ分離する

- Created: 2026-09-20
- Completed: {YYYY-MM-DD}
- Branch: feature/refactor-split-audio-hooks
- Polished: 2026-09-28
- Refreshed: 2026-11-09

## 目的

devtools に音声の配信と購読を追加した結果、`devtools/src/hooks/usePublisher.ts` と `devtools/src/hooks/useSubscriber.ts` が映像と音声の両方を 1 ファイルで扱うようになり、どちらも 1000 行を超えた。issue 作成時点 (2026-09-20) は 1141 行 / 1233 行であり、現在 (2026-11-09) は 2450 行 / 3418 行である。音声は次の点で映像と独立した構造を持つため、同じファイルに置く必然性が無い。

- Group 採番: draft-ietf-moq-loc-05 §4.1 により音声は chunk 1 つごとに Group を進める (映像はキーフレームで進める)
- publish / subscribe: 音声は映像とは別の `session.publish` と `session.subscribe` を持つ
- 優先度: 音声は `PRIORITY_AUDIO` を使う
- 再生: 音声だけが AudioContext を持ち、AudioContext の destination へ直接出力する (`<audio>` 要素は使わない)

分離して見通しを戻し、以後の変更 (可視化・統計・相互運用の追加) が映像側と干渉しないようにする。

## 現状

- `devtools/src/hooks/usePublisher.ts` に映像の配信経路と音声の配信経路 (`startAudioStream` / `prepareAudioForPublishing` / `takeAudioFrameSourceForPublishing` / `startPreviewAudio` / `stopAudioStream` / `processAudioFrames` / `startAudioPublishing` / `handleAudioEncodedChunk` / `resolveAudioConfigToSend` / `resolveAudioPublishable`) が同居する。音声レベルの時刻解決は `devtools/src/utils/audioLevelTimeline.ts` の `AudioLevelTimeline#levelFor` が担い、`usePublisher.ts` は呼び出すだけである
- `devtools/src/hooks/usePublisher.ts` の `resolveAudioConfigToSend` は `src/createMediaPublisher.ts` が export している同名関数 (パッケージ公開 API ではない) と同じ判定 (直前と違う description なら載せ、送り直し要求には保持値で応える) を再実装している。ライブラリ側は `description.length > 0` のガードを持つ点だけが異なる
- `devtools/src/hooks/useSubscriber.ts` に映像の購読経路と音声の購読経路 (`startAudioSubscription` / `subscribeAudioOnly` / `handleAudioObject` / `handleAudioDecoded`) が同居する。再生の開始と停止は `devtools/src/hooks/audioPlaybackController.ts`、停止時の drain は `devtools/src/hooks/subscriberAudioStop.ts`、開始と停止の判定は `devtools/src/hooks/audioPlaybackLifecycle.ts`、復号前遅延は `devtools/src/hooks/subscriberPreDecodeDelay.ts` に切り出し済みで、`useSubscriber.ts` には結線と呼び出しが残る
- signal は既に `devtools/src/signals/publisher.ts` / `devtools/src/signals/subscriber.ts` に分かれており、フックだけが混在している
- `devtools/src/signals/subscriber.ts` の `removeSubscriber` と `useSubscriber.ts` の `closeSubscriberResources` は、どちらも「映像 decoder → 音声 decoder → catalog 購読 → 音声トラック購読 → session」の順で後始末を持ち、順序を手で揃えている (event timeline 購読の解除は `closeSubscriberResources` だけにある)
- `issues/0828-refactor-share-playout-paths.md` の第 3 段 (購読そのもの) と第 4 段 (devtools の音声 Object の経路) は、音声の購読経路をライブラリの共有実装へ寄せる。第 3 段のうち catalog の購読は `src/mediaSubscriber/catalogSubscription.ts` の `CatalogSubscription` として先行実装済みである。音声と映像の track 購読は、ライブラリ (`src/createMediaSubscriber.ts`) と devtools (`useSubscriber.ts`) の 2 実装のままである
- `issues/0830-refactor-devtools-audio-delivery.md` は `devtools/src/types.ts` の `AudioDelivery` と、`usePublisher.ts` の送信経路 (`shouldSendAudioAsDatagram` / `buildAudioSendCopyPlan` / `loggedAudioDatagramFallback`) を変更対象にする。本 issue が切り出す音声配信経路と範囲が重なる

## 設計方針

- 分離の際に、Audio Config の送出判断はライブラリの `src/createMediaPublisher.ts` が export している `resolveAudioConfigToSend` を import して使う (devtools 側の再実装を削除する)。`isSameCodecDescription` はライブラリが export しておらず、購読側の判断 (`useSubscriber.ts`) でも使うため `devtools/src/utils/codec.ts` に残す (音声の送出判断からは不要になる)。判定の差分 (`description.length > 0` のガード) はライブラリ側の挙動に揃える。devtools は既に `selectCodecDescription` を `src/createMediaPublisher.ts` から import して呼んでいるため、ライブラリの `resolveAudioConfigToSend` へ乗り換えると空の description の扱いもライブラリ側に揃う

- 音声の配信経路を `devtools/src/hooks/useAudioPublisher.ts`、音声の購読経路を `devtools/src/hooks/useAudioSubscriber.ts` (または `devtools/src/hooks/audio/` 配下) へ切り出す。既存の音声専用モジュール (`audioPlaybackController.ts` / `audioPlaybackLifecycle.ts` / `publisherAudioMeter.ts` / `subscriberAudioStop.ts`) は `devtools/src/hooks/` 直下にフラットに置かれており、`audio/` 配下は存在しない
- 後始末の順序は 1 箇所に集約する (映像と音声を 1 つのクローズ処理から呼ぶ形にし、順序の二重管理を無くす)
- signal の置き場と名前は変えない (切り出しの差分を機械的にするため)
- 振る舞いを変えない。既存のテストと E2E がそのまま通ることを確認する

## 完了条件

- `usePublisher.ts` / `useSubscriber.ts` から音声固有の処理が無くなり、それぞれ元の規模に近づく
- 後始末の順序が 1 箇所で表現される
- `vp check` / `vp test` / `vp run e2e-test` が通る (振る舞いを変えない)

## 参照

- draft-ietf-moq-loc-05 §4.1 (Application with one audio track: 音声は 1 chunk = 1 Object = 1 Group)
- draft-ietf-moq-msf-01 §5.2.6 (Track role) / §6.1 (Group numbering)

## 解決方法

{未着手}
