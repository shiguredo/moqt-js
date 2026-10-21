# 音声だけの到着基準再生の遅れに下限を入れて Wi-Fi の停滞を吸収する

- Created: 2026-10-21
- Completed: {YYYY-MM-DD}
- Branch: feature/add-audio-only-arrival-delay-floor
- Polished: {YYYY-MM-DD}

## 目的

音声だけを購読するデモを Wi-Fi で動かすと、到着基準の再生の遅れが 100 ms に張り付き、
Wi-Fi の周期的な約 105 ms の停滞を吸収しきれず、60 秒に 1 回 109 ms の無音の穴
(うち復旧できない分 32 ms) が出る。音声だけの購読は映像に合わせる相手が無いため、
到着基準の再生の遅れに下限を足して 120〜140 ms にする。上限を上げるだけでは直らない
ことは実測で確認済みであり、その理由も issue に残す。

## 現状

- `src/playout/audioPlayout.ts` の `arrivalPlayoutDelaySeconds` は、共有の時間軸が学習した
  遅れ (`learnedDelaySeconds`) を下限 50 ms、上限 `AUDIO_PLAYOUT_ARRIVAL_DELAY_MS` (100 ms)
  の間に切る
- 音声だけの購読では `enforceTarget` が false のため到着基準で並べるが、学習した遅れは
  閉ループの目標 (既定の上限 100 ms) に追随して 100 ms になる
- 閉ループの適用上限は、圧縮か無音の穴が 2 秒続いたときだけ 160 ms へ広がる。Wi-Fi の
  孤立した穴 1 回では広がらず、目標を上げても 100 ms に切り戻される。そのため
  `AUDIO_PLAYOUT_ARRIVAL_DELAY_MS` を 140 に上げても、学習した遅れが 100 ms のままなので
  実際の再生の遅れは 100 ms から変わらない (2026-10-21 の実測で確認する)
- 実リレーの音声だけの 60 秒計測 (2026-10-21、Wi-Fi): `gapCount` 1 / `gapMs` 109.3 /
  `unrecoverableGapMs` 32.3 / `boundaryStepCount` 1。到着の停滞は 60 秒に 116 回、
  周期 p50 524.5 ms、間隔の p99 97.7 ms、最大 98.6 ms

## 設計方針

- `AudioPlayoutRequest` に、到着基準の再生の遅れの下限 (`arrivalDelayFloorMs`、省略時 0) を
  足す。`AudioPlayoutSession` は学習した値から求めた遅れと下限の大きい方を使う
- 下限は「映像に合わせる相手が無い購読」だけで渡す。ライブラリは `videoTrackInfo` が
  null のとき、devtools は音声だけの購読 (`audioOnlyPlaybackRef`) のとき
- 下限の値は実リレーの A/B で決める。Wi-Fi の 60 秒計測を 0 ms (現状) / 120 ms / 140 ms の
  3 腕で 3 回ずつ交互に回し、無音の穴 (特に復旧できない分) が 0 になる最小の値を選ぶ。
  再生開始が遅くなる分 (`startDelayMs` の増加) も併記する
- 上限は既存の 100 ms のままにする。下限を足すのは「揺らぎの推定が届いていない停滞を
  先に確保する」ためであり、学習した遅れが上限を超える経路への適応は別の issue とする
- 単体テストで、下限を渡したときの到着基準の開始時刻、音声だけの購読が下限を渡すこと、
  映像ありの購読が下限を渡さないことを固定する

## 完了条件

- 実リレーの A/B (0 / 120 / 140 ms、各 3 回) の結果を issue に残し、採用値を決めている
- 採用値を `AudioPlayoutSession` の下限として実装し、ライブラリと devtools の
  音声だけの購読から渡している
- 実リレーの音声だけの 60 秒計測で、復旧できない無音の穴が 0 になることを確認している
- 単体テストで下限の挙動と、映像ありでは下限を渡さないことを固定している
- `vp check` / `tsc --noEmit` / `vp test run` が通る

## 解決方法

{対応時に記入}
