# ライブラリの音声購読が LARGEST_OBJECT 以前の cache 音声を鳴らすのを直す

- Created: 2026-10-21
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-playout-audio-correctness
- Polished: {YYYY-MM-DD}

## 目的

devtools は SUBSCRIBE_OK の LARGEST_OBJECT 以前の音声を復号するが鳴らさない。ライブラリの
`MediaSubscriber` には同じ境界がなく、購読のやり直しで cache から届いた古い音声を再生し、
共有の時間軸 (`PlayoutTimeline.observe`) に古い TIMESTAMP を混ぜる。通常は最大 1 Object
(20 ms) で影響は小さいが、publisher の Group 構成や購読の filter が変わると、古い音声の
再生と時間軸の基準の取り直しで遅延が跳ねる。

## 現状

- `devtools/src/hooks/useSubscriber.ts` は `src/catchUpGate.ts` の `CatchUpGate` を音声用に
  持ち、`admitPlayAudio` で LARGEST_OBJECT 以前の音声を鳴らさない
- `src/createMediaSubscriber.ts` の `subscribeMediaTracks` は購読確立後に
  `audioSubscriber` を保持するが、`largestLocation` を音声の受信判定に使っていない
- ライブラリの音声は `receiveAudioObject` からそのまま復号へ渡り、復号の出力が
  `AudioPlayoutSession` で時間軸へ記録される

## 設計方針

- 購読確立時に `audioSubscriber.largestLocation` を境界として保持し、`receiveAudioObject`
  の入口で `compareLocations(location, boundary) <= 0` の Object (境界以前) を復号へ渡さず
  捨てる。境界が null のときは全 Object を live として扱う
- 捨てた数を計器に出す (`audioCatchUpObjectsSkipped` 相当)。購読の停止と開始で境界を
  リセットする
- `src/catchUpGate.ts` の判定をそのまま使えるなら再利用し、重複した実装を増やさない
- `docs/HIGH_LEVEL_API.md` の音声統計の説明に、境界以前を捨てた数の意味を書く

## 完了条件

- 単体テストで、境界以前の Object を復号へ渡さないこと、境界以後は渡すこと、境界が無い
  (LARGEST_OBJECT 省略) ときは全 Object を渡すこと、購読のやり直しで境界がリセットされる
  ことを固定する
- 計器が増えたことを `docs/HIGH_LEVEL_API.md` に書く
- `vp check` / `tsc --noEmit` / `vp test run` が通ること

## 解決方法

{対応時に記入}
