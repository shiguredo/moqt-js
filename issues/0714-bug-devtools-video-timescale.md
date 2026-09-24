# moqt-devtools の subscriber が Timescale のある映像の TIMESTAMP をマイクロ秒に換算せずに使う

- Created: 2026-09-25
- Completed: 2026-09-25
- Branch: feature/fix-devtools-video-timescale
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-loc-04 Section 2.3.1.2 は、Timescale があるとき TIMESTAMP の単位を「the number of Timestamp units per second」で表す (例: 映像の 90 kHz は 90000)。WebCodecs の EncodedVideoChunk の timestamp はマイクロ秒である。moqt-devtools の subscriber は映像の TIMESTAMP を Timescale を見ずにそのまま chunk の timestamp にするため、Timescale を載せる publisher の映像では chunk の timestamp の単位が合わない。

受信から表示までの時間の統計 (`playbackTiming`) は chunk の timestamp をマイクロ秒として扱うため、Timescale 90000 の映像ではフレーム間隔や到着の揺らぎを 1000 / 90 倍に誤って求める。

## 現状

- `devtools/src/hooks/useSubscriber.ts` の `buildVideoChunkPlan` は `Number(locProperties.timestamp)` を timestamp にし、`locProperties.timescale` を見ない
- 同じファイルの音声は `LOC.toDecoderMicroseconds(locProperties.timestamp, locProperties.timescale)` で換算している
- ライブラリの `src/createMediaSubscriber.ts` の `decoderTimestampOf` も `LOC.toDecoderMicroseconds` で換算している

## 設計方針

- `buildVideoChunkPlan` の timestamp を `LOC.toDecoderMicroseconds` で換算する (音声とライブラリに揃える)
- `timestampKind` (Timescale の有無で `wallClock` / `mediaTime`) は変えない

## 完了条件

- Timescale 90000 の TIMESTAMP がマイクロ秒に換算されることを単体テストで固定する
- Timescale の無い TIMESTAMP はそのまま使うことを単体テストで固定する
- `vp check` と全テストが通る

## 解決方法

- `devtools/src/hooks/useSubscriber.ts` の `buildVideoChunkPlan` が timestamp を `LOC.toDecoderMicroseconds(timestamp, timescale)` で換算するようにした。Timescale が無ければ値をそのまま使う (音声とライブラリの `createMediaSubscriber` と同じ)
- テスト: Timescale 90000 の TIMESTAMP 3003 が 33366 マイクロ秒になること、Timescale の無い TIMESTAMP はそのまま使うこと (既存テスト) を `useSubscriber.test.ts` で固定した
- `vp check` と全テスト (129 ファイル / 2651 件) が通った
