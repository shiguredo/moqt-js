# 音声だけの購読で jitter 推定が床に固定し時間圧縮が 0 になる原因を特定して直す

- Created: 2026-10-21
- Completed: 2026-10-21
- Branch: feature/fix-audio-demo-hardening
- Polished: {YYYY-MM-DD}

## 目的

Wi-Fi のデモで音声だけを購読すると、到着の尾は映像ありと同じなのに `jitterTargetMs` が
80 ms の床に固定し、`appliedMs` 80、`compressedMs` 0 になる。しかも `startDelayMs` は
139 ms で映像あり (122 ms) より大きい。到着の揺らぎに推定が反応していない可能性があり、
音声だけのデモで遅延と音質の制御が効かない。

## 現状

- devtools の音声だけの購読では映像の時間軸が無く、`AudioPlayoutSession` の `enforceTarget`
  が false になり到着基準の再生になる
- `src/playout/audioDelayFeedback.ts` は共有の時間軸の `playoutDelayMs` と圧縮・穴の観測から
  目標を決める
- 2026-10-16 と 2026-10-21 の実リレー計測で、到着の尾が同じでも音声だけでは
  `jitterTargetMs` 80 / `appliedMs` 80 / `compressedMs` 0、`startDelayMs` 139 ms になる現象が
  再現している。原因は未特定

## 設計方針

- 映像あり / なしで `jitterTargetMs` / `appliedMs` / `playoutDelayMs` / `enforceTarget` /
  `arrivalPlannedFrames` の遷移を 250 ms 間隔で記録する調査 spec を追加し、
  `audioDelayFeedback.update` の入力が音声だけの場合にどこで止まるかを追う
- 原因が判明したら、時間軸の有無に依存せず jitter 推定を反映する修正を入れる
- 原因が仕様上の意図 (到着基準では推定を使わない) なら、その旨を docs と devtools の
  説明に明記する

## 完了条件

- 原因をファイルとシンボル名付きで特定する
- 修正する場合は単体テストで固定し、実リレーの音声だけの計測で `jitterTargetMs` が到着の
  尾に反応することを確認する
- 仕様上の意図なら docs と help に明記する
- `vp check` / `tsc --noEmit` / `vp test run` が通ること

## 解決方法

音声だけを購読すると、devtools が jitter buffer を無効にして映像の時間軸を作らないため、
NetEq の揺らぎ推定と閉ループが動かず、`jitterTargetMs` が 80 ms の初期値に固定し、受信側の追いつきも
動かなかった。`devtools/src/hooks/useSubscriber.ts` の `subscribeAudioOnly` で音声用の
`PlayoutTimeline` を作り、`useTimeline` を有効にした (`enforceTarget` は映像が無いため false のまま)。
`src/playout/timeline.ts` に `audioDelayFeedbackStats()` を追加し、`devtools` の音声統計
`audio.audioDelayFeedback` と Audio Playback の表示から、音声だけでも目標・実際に使う値・上限・
圧縮の速さを読めるようにした。A/V 同期の推定は映像が無いため出さない。

検証: 実リレーの音声だけの 60 秒計測 (videoSource=none、同一ページ) で、修正前は
`jitterTargetMs` 80 / `appliedMs` 80 の固定だったものが、修正後は到着の揺らぎに反応して
`jitterTargetMs` 80 → 100、`appliedMs` 80 → 100、reason が `waiting` に変わることを確認した
(100 ms は到着基準の再生遅延の上限であり、Wi-Fi の周期的な約 105 ms の停滞はまだ僅かに超える)。
`vp check` / `tsc --noEmit` / `vp test run` が通る。
