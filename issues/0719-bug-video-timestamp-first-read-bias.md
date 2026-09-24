# 映像の TIMESTAMP の壁時計への換算が最初のフレームを読むまでの遅れの分だけ偏り、moqt-devtools の遅延が小さく (負に) 出る

- Created: 2026-09-25
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-video-timestamp-first-read-bias
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-loc-04 Section 2.3.1.1 により、Timescale を載せない LOC の TIMESTAMP は Unix epoch のマイクロ秒 (壁時計) である。moqt-devtools と `createMediaPublisher` は、映像の VideoFrame の timestamp を壁時計に換算して送る (`src/mediaClock.ts`)。換算は、最初に読んだフレームの timestamp と、そのフレームを読んだときの壁時計を対応づけ、以降は timestamp の差を足す。

最初のフレームは撮ってから読むまでに遅れる (encoder の初期化などで開始時に大きく、開発モードではさらに大きい)。その遅れの分だけ、以降のすべての TIMESTAMP が実際に撮った時刻より未来にずれる。受信側の遅延 (受信側の壁時計 - TIMESTAMP) はその分だけ小さく、負にもなる。

実測 (2026-09-25、同じ Chromium の publisher と subscriber、1280x720 / 30 fps / 2 Mbps、配備 relay、経路の RTT は約 36 ms):

- dev サーバーの devtools: `latencyMs` p50 -1.6 ms / p95 9.2 ms / max 25.5 ms
- 配備の devtools (本番ビルド): `latencyMs` p50 29.2 ms / p95 40 から 47 ms

同じマシン同士の遅延が負になるのは誤りである。本番ビルドでも同じ偏りが小さく入っている可能性がある。

## 現状

- `src/mediaClock.ts` の `createWallClockAnchor` は、1 つのフレームの timestamp と読んだときの壁時計から対応を作り、`toWallClockMicroseconds` はその対応に timestamp の差を足す
- `src/createMediaPublisher.ts` の `processVideoFrames` と `devtools/src/hooks/usePublisher.ts` の `processFrames` は、最初に読んだフレームだけで対応を作り、以降は変えない

## 設計方針

- フレームを読むたびに「読んだときの壁時計 - timestamp」を記録し、その最小値 (撮ってから読むまでの遅れが最も小さいフレーム) を対応に使う
- 対応を後から変えると、換算した TIMESTAMP が前のフレームより戻ることがある。換算に使う対応は最小値へ向けて動かすが、1 回の換算で動かす量を前のフレームとの timestamp の差の半分未満に抑え、換算した TIMESTAMP が単調に増えるようにする
- 対応は小さくする向きにだけ動かす。VideoFrame の timestamp と `performance.now()` は同じ単調な時計に基づく (Chromium の canvas の captureStream と fake camera) ため、ずれは広がらない
- 換算の状態は純粋なクラスに持たせ、時刻は引数で受ける

## 完了条件

- 開始時に読み取りが遅れる列で、換算した TIMESTAMP と撮った時刻の差が最小の読み取りの遅れに収束することを単体テストと PBT で固定する
- 換算した TIMESTAMP が単調に増えること、撮った時刻より前にならないことを PBT で固定する
- 配備の devtools と dev サーバーの devtools の両方で、同じマシンの publisher と subscriber の `latencyMs` p50 が正の値 (配備 relay で 20 から 40 ms 程度) になり、両者がほぼ一致することを確かめる
- `vp check` と全テストが通る
