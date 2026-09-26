# `createMediaSubscriber` が映像を LOC TIMESTAMP の間隔で表示する

- Created: 2026-09-26
- Completed: {YYYY-MM-DD}
- Branch: feature/add-media-subscriber-video-playout
- Polished: 2026-09-26

## 目的

映像の jitter buffer は moqt-devtools にしか無い。`createMediaSubscriber` は復号したフレームをすぐ `MediaStreamTrackGenerator` に書くため、経路の到着の揺らぎがそのまま表示間隔になる。音声の再生時刻はすでに `src/audioPlayout.ts` にあり、ライブラリと devtools の両方が使っている。映像も同じで、壁時計の LOC TIMESTAMP で表示する処理はライブラリを使う側が必ず必要になる。計算を devtools に残すと、アプリごとに同じ追いつきと再生遅延を書き直すことになる。

## 現状

- `devtools/src/utils/playoutBuffer.ts` の `PlayoutBuffer` が、壁時計の TIMESTAMP に遅れを足した表示時刻を決める。ブラウザ API には依存せず、時刻は引数で受ける。Timescale の無い TIMESTAMP は Unix epoch マイクロ秒の壁時計である (draft-ietf-moq-loc-04 Section 2.3.1.1)。Timescale がある TIMESTAMP はメディア時刻であり、壁時計の表示時刻には使わない
- `devtools/src/hooks/useSubscriber.ts` の `presentFrame` は、jitter buffer が有効で TIMESTAMP が壁時計のときだけ `PlayoutBuffer` に timestamp を渡し、`requestAnimationFrame` で canvas に描く。無効のときは届いた順に 1 周期に 1 枚描く
- `src/createMediaSubscriber.ts` の `handleVideoDecodedData` は、復号した `VideoFrame` を待たずに `videoWriter.write` する
- 音声は `handleAudioDecodedData` が `src/audioPlayout.ts` の `AudioPlayoutScheduler` で鳴らす時刻を決める。devtools の音声再生も同じモジュールを使う
- `createMediaPublisher` の映像は `WallClockMapper.toWallClockMicroseconds` で壁時計の TIMESTAMP にする。`LOC.toUnixEpochMicroseconds` は音声である (`handleAudioEncodedChunk`)
- `PlayoutBuffer` は `devtools/src/utils/timedValues.ts` の `TimedValues` を使う。`TimedValues` は devtools の統計 (`playbackTimingStats` / `publishTimingStats` / `latencyBreakdown`) も使っている
- テストは `devtools/src/utils/playoutBuffer.test.ts` と `devtools/src/utils/playoutBuffer.prop.ts` にある

## 設計方針

- 表示時刻の計算は `PlayoutBuffer` のままライブラリ (`src/`) に置く。アルゴリズム (基準の遅れ、再生遅延、追いつき、間に合わなかったフレームを捨てる) は変えない。`select` は表示周期ごとに呼ぶ (`devtools` は `requestAnimationFrame`)
- `MediaStreamTrackGenerator` は `write` したフレームをその時点でトラックへ出す。`VideoFrame.timestamp` を表示時刻に書き換えて先に `write` しても、表示は待たない。`createMediaSubscriber` は `PlayoutBuffer.select` が描くと決めたフレームだけを `videoWriter.write` する
- `select` は表示周期ごとに呼び、キューが残っている間は次の周期も予約する。devtools は `requestAnimationFrame` の `scheduleFrameDrain` がこれを行う。`createMediaSubscriber` も同じで、復号の出力のときだけ `select` しない。次のフレームが届くまで期限を過ぎたフレームが残るためである
- キューの上限で捨てたフレームと、表示に間に合わず捨てたフレームは `close` する。`write` に成功したフレームは Generator の所有なので閉じない (`handleVideoDecodedData` の今の所有と同じ)
- フレームをどこへ渡すかは受け側に残す。devtools は canvas、`createMediaSubscriber` は `MediaStreamTrackGenerator`
- Timescale がある TIMESTAMP と TIMESTAMP の無いフレームは、devtools と同じく壁時計の表示時刻に使わない
- 時刻の軸は `performance.now()` のままにする。音声の `AudioPlayoutScheduler` は `AudioContext.currentTime` で、映像とは別の時計である。映像と音声を同じ時計に揃えることはこの issue ではしない
- `TimedValues` は `PlayoutBuffer` と一緒に `src/` へ置く。`audioPlayout.ts` と同じくパッケージの公開入口 (`src/index.ts`) には出さない。devtools の統計はそこから import する
- 無効にするスイッチは devtools の設定のままにする。`createMediaSubscriber` に無効のオプションは足さない。ライブラリの映像再生は有効が既定であり、再生遅延の分だけ今より遅れて出る

## 完了条件

- `PlayoutBuffer` と `TimedValues`、既存の単体テストと PBT が `src/` にあり、devtools はそこを使う。`src/index.ts` には出さない
- `createMediaSubscriber` は、キューが残っている間、表示周期ごとに `select` を呼ぶ。描くと決めたフレームだけを `videoWriter.write` し、表示時刻前のフレームは書かない。復号の出力のときだけの `select` では完了しない
- 捨てた `VideoFrame` は `close` する。`write` に成功したフレームは閉じない
- Timescale がある TIMESTAMP と TIMESTAMP の無いフレームは、壁時計の表示時刻に使わない
- `vp check` / `tsc --noEmit` / `vp test run` が通る
