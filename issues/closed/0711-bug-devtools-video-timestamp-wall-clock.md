# moqt-devtools の publisher が映像の LOC TIMESTAMP を VideoFrame の timestamp のまま送り、Unix epoch の壁時計として読めない

- Created: 2026-09-25
- Completed: 2026-09-25
- Branch: feature/fix-devtools-video-timestamp-wall-clock
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-loc-04 Section 2.3.1.1 は「If no timescale property is present, the timestamp is interpreted as wall-clock time in microseconds since the Unix epoch.」と定める。moqt-devtools の publisher は映像の Object に Timescale を載せずに、VideoFrame の timestamp をそのまま TIMESTAMP として送る。受信側はこの値を壁時計として読むため、送信から受信までの遅延を求められない (受信側のかくつきを調べるための統計に使えない)。

VideoFrame の timestamp の基準は映像の取得元で異なる。Chromium で MediaStreamTrackProcessor から読んだ最初のフレームの timestamp を調べると (2026-09-25):

- canvas の `captureStream()` (devtools のダミー映像): 0 (stream の開始が基準)
- fake camera: 289052241 ms (`performance.now()` とも stream の開始とも一致しない)
- 音声 (fake microphone): 2707 ms (`performance.now()` の 2707 ms と一致する)

## 現状

- `devtools/src/hooks/usePublisher.ts` の `buildObjectSendPlan` は `LOC.encodeVideoProperties({ timestamp: BigInt(chunk.timestamp), ... })` で TIMESTAMP を作り、Timescale を載せない
- 同じファイルの音声 (`handleEncodedAudioChunk` 周辺) は `LOC.toUnixEpochMicroseconds(BigInt(chunk.timestamp), performance.timeOrigin)` で換算している。音声の取得元は `performance.now()` 基準のため壁時計になる
- `devtools/src/hooks/useSubscriber.ts` の `buildVideoChunkPlan` は TIMESTAMP を `Number()` で EncodedVideoChunk の timestamp に使う

## 設計方針

- 最初に読んだフレームの timestamp と、そのときの壁時計 (`performance.timeOrigin + performance.now()`) の対応を配信ごとに保持し、以降のフレームは timestamp の差を足して壁時計に換算する。取得元ごとの基準の違いに依存しない。フレームの読み出しは取得の直後に行うため、換算した壁時計と実際の取得時刻の差は小さい
- 換算はブラウザ API に依存しない純関数にし、`buildObjectSendPlan` は対応を引数で受ける
- 購読側は Unix epoch マイクロ秒 (現在は約 1.79e15) をそのまま `Number` にしても安全整数 (2^53 - 1) の範囲に収まることをテストで固定する
- 音声は `performance.now()` 基準で正しく換算できているため変えない

## 完了条件

- `buildObjectSendPlan` が載せる TIMESTAMP が、対応の壁時計にフレームの timestamp の差を足した値になることをテストで固定する (取得元の基準が 0 / 大きな値のどちらでも)
- 換算がフレームの間隔を保つことを PBT で固定する
- 購読側が epoch マイクロ秒の TIMESTAMP を誤差なく timestamp にすることをテストで固定する
- `vp check` と全テストが通る

## 解決方法

- `devtools/src/utils/wallClock.ts` を足した。`createWallClockAnchor(mediaMicros, wallClockMillis)` で最初に読んだフレームの timestamp とそのときの壁時計 (Unix epoch マイクロ秒に丸める) の対応を作り、`toWallClockMicroseconds(mediaMicros, anchor)` で対応の壁時計に timestamp の差を足して換算する。Unix epoch より前 (負) にはしない
- `devtools/src/signals/publisher.ts` に対応 (`videoClockAnchor`) を持たせた。`usePublisher` の `processFrames` が最初に読んだフレームで `performance.timeOrigin + performance.now()` と対応をとり、配信の開始と `cleanupPublisher` で消す
- `buildObjectSendPlan` は対応を引数で受け、TIMESTAMP を壁時計に換算して載せる
- テスト: 基準が 0 (canvas) と大きな値 (fake camera) のフレームの換算、負にしないこと (`wallClock.test.ts`)、換算がフレームの間隔を保つことと安全整数に収まること (`wallClock.prop.ts`)、`buildObjectSendPlan` が壁時計の TIMESTAMP を載せること (`usePublisher.test.ts`)、購読側の `buildVideoChunkPlan` が epoch マイクロ秒を誤差なく timestamp にすること (`useSubscriber.test.ts`)
- `vp check` と全テスト (127 ファイル / 2628 件) が通った

ライブラリの `createMediaPublisher` にも同じ問題があり、別の issue で扱う。
