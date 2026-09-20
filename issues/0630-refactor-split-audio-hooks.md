# devtools の音声の配信と購読の経路をフックへ分離する

- Created: 2026-09-20
- Completed: {YYYY-MM-DD}
- Branch: feature/refactor-split-audio-hooks
- Polished: {YYYY-MM-DD}

## 目的

devtools に音声の配信と購読を追加した結果、`devtools/src/hooks/usePublisher.ts` と `devtools/src/hooks/useSubscriber.ts` が映像と音声の両方を 1 ファイルで扱うようになり、どちらも 1000 行を超えた。音声は次の点で映像と独立した構造を持つため、同じファイルに置く必然性が無い。

- Group 採番: draft-ietf-moq-loc-04 §4.1 により音声は chunk 1 つごとに Group を進める (映像はキーフレームで進める)
- publish / subscribe: 音声は映像とは別の `session.publish` と `session.subscribe` を持つ
- 優先度: 音声は `PRIORITY_AUDIO` を使う
- 再生: 音声だけが AudioContext と `<audio>` を持つ

分離して見通しを戻し、以後の変更 (可視化・統計・相互運用の追加) が映像側と干渉しないようにする。

## 現状

- `devtools/src/hooks/usePublisher.ts` に映像の配信経路と音声の配信経路 (`startAudioStream` / `stopAudioStream` / `takeAudioTrackForPublishing` / `startAudioPublishing` / `handleAudioEncodedChunk` / `resolveAudioLevelForTimestamp` / `resolveAudioConfigToSend` / `resolveAudioPublishable`) が同居する
- `devtools/src/hooks/useSubscriber.ts` に映像の購読経路と音声の購読経路 (`startAudioSubscription` / `handleAudioObject` / `handleAudioDecoded` / 再生の開始と停止) が同居する
- signal は既に `devtools/src/signals/publisher.ts` / `devtools/src/signals/subscriber.ts` に分かれており、フックだけが混在している
- `devtools/src/signals/subscriber.ts` の `removeSubscriber` と `useSubscriber.ts` の `closeSubscriberResources` は、どちらも「映像 decoder → 音声 decoder → catalog 購読 → 音声トラック購読 → session」の順で後始末を持ち、順序を手で揃えている

## 設計方針

- 音声の配信経路を `devtools/src/hooks/useAudioPublisher.ts`、音声の購読経路を `devtools/src/hooks/useAudioSubscriber.ts` (または `devtools/src/hooks/audio/` 配下) へ切り出す
- 後始末の順序は 1 箇所に集約する (映像と音声を 1 つのクローズ処理から呼ぶ形にし、順序の二重管理を無くす)
- signal の置き場と名前は変えない (切り出しの差分を機械的にするため)
- 振る舞いを変えない。既存のテストと E2E がそのまま通ることを確認する

## 完了条件

- `usePublisher.ts` / `useSubscriber.ts` から音声固有の処理が無くなり、それぞれ元の規模に近づく
- 後始末の順序が 1 箇所で表現される
- `npx vp check` / `npx vp test --run` / `npx vp run e2e-test` が通る (振る舞いを変えない)

## 参照

- draft-ietf-moq-loc-04 §4.1 (Application with one audio track: 音声は 1 chunk = 1 Object = 1 Group)
- draft-ietf-moq-msf-01 §5.2.6 (Track role) / §6.1 (Group numbering)

## 解決方法

{未着手}
