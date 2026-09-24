# createMediaPublisher が映像の LOC TIMESTAMP を timeOrigin と VideoFrame の timestamp の和で求め、カメラや canvas の映像では壁時計にならない

- Created: 2026-09-25
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-media-publisher-video-timestamp-wall-clock
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-loc-04 Section 2.3.1.1 は「If no timescale property is present, the timestamp is interpreted as wall-clock time in microseconds since the Unix epoch.」と定める。`createMediaPublisher` は映像の TIMESTAMP を `LOC.toUnixEpochMicroseconds(BigInt(chunk.timestamp), performance.timeOrigin)` で求める。この換算は VideoFrame の timestamp が `performance.now()` 基準であることを前提にするが、映像の取得元ではこの前提が成り立たない。

Chromium で MediaStreamTrackProcessor から読んだ最初のフレームの timestamp を調べると (2026-09-25):

- canvas の `captureStream()`: 0 (stream の開始が基準)。換算した TIMESTAMP はページを開いた時刻付近になり、実際の取得時刻より stream の開始までの時間だけ古くなる
- fake camera: 289052241 ms。換算した TIMESTAMP は実際の時刻より約 80 時間先になる
- 音声 (fake microphone): 2707 ms で `performance.now()` と一致する。音声の換算は成り立つ

受信側が TIMESTAMP を壁時計として遅延の計算や音声と映像の同期 (issue の「音声と映像を LOC Timestamp と targetLatency で同期して再生する」) に使うと、映像だけが大きくずれる。

## 現状

- `src/createMediaPublisher.ts` の映像の Object 送信は `LOC.toUnixEpochMicroseconds(BigInt(chunk.timestamp), performance.timeOrigin)` を TIMESTAMP にし、Timescale を載せない
- `src/loc.ts` の `toUnixEpochMicroseconds` のコメントは「WebCodecs の chunk.timestamp は timeOrigin 基準の単調時刻」とする

## 設計方針

- 最初に読んだフレームの timestamp とそのときの壁時計の対応を track ごとに保持し、以降のフレームは timestamp の差を足して壁時計に換算する (moqt-devtools の publisher と同じ方式)
- `toUnixEpochMicroseconds` のコメントの前提を実態に合わせる

## 完了条件

- 映像の TIMESTAMP が、最初のフレームを読んだときの壁時計にフレームの timestamp の差を足した値になることをテストで固定する (取得元の基準が 0 / 大きな値のどちらでも)
- `vp check` と全テストが通る
