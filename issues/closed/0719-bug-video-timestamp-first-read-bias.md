# 映像の TIMESTAMP の壁時計への換算が最初のフレームを読むまでの遅れの分だけ偏り、moqt-devtools の遅延が小さく (負に) 出る

- Created: 2026-09-25
- Completed: 2026-09-25
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

## 解決方法

- `src/mediaClock.ts` の `createWallClockAnchor` / `toWallClockMicroseconds` を `WallClockMapper` に置き換えた。`observe(mediaMicros, wallClockMillis)` はフレームを読むたびに「読んだときの壁時計 - timestamp」を記録して最小値を目標にし、`toWallClockMicroseconds(mediaMicros, fallbackWallClockMillis?)` は換算に使う対応を目標へ向けて動かして換算する。1 回の換算で動かす量は、前に換算したフレームとの timestamp の差の半分未満 (1 マイクロ秒引く) に抑え、換算した TIMESTAMP の差が timestamp の差の半分より大きく保たれる (単調に増える)。30 fps では 1 回あたり約 16.7 ms 未満で、開始時の数百 ms の遅れは 1 秒ほどで埋まる。対応は小さくする向きにだけ動かす (VideoFrame の timestamp と `performance.now()` は同じ単調な時計に基づくため、ずれは広がらない)。記録が無いまま換算するときは渡した壁時計で読んだとみなし、それも無ければ throw する
- `createMediaPublisher` の `processVideoFrames` と moqt-devtools の `usePublisher` の `processFrames` は、読んだすべてのフレームを `observe` し、encoder の出力で `toWallClockMicroseconds` する。devtools の `buildObjectSendPlan` は換算済みの TIMESTAMP を引数で受けてそのまま載せる (換算の状態を持たない純関数に保つ)
- テスト: 開始時の 300 ms の遅れのフレームがあっても最小の遅れに合わせること、換算の途中で対応を動かしても単調に増えて最小の遅れへ近づくこと、遅れの大きいフレームでは動かさないこと、基準が大きな値の timestamp、Unix epoch より前にしないこと、記録が無いときの扱い (`src/mediaClock.test.ts`)。任意の読み取りの遅れと encoder の遅れで単調に増え、撮った時刻にそれまでの最小の遅れを足した時刻より前にならないこと、十分に換算すると最小の遅れに収束すること (`src/mediaClock.prop.ts`)。`createMediaPublisher` と devtools の既存テストを新しい API に合わせた
- 未リリースの CHANGES.md の 2 つの項目 (devtools と `createMediaPublisher` の映像の TIMESTAMP) の記述を新しい換算に合わせた
- `vp check` と全テスト (134 ファイル / 2692 件) が通った

同じ Chromium の publisher と subscriber、1280x720 / 30 fps / 2 Mbps、配備 relay、20 秒で、受信側の `latencyMs` を測った (2026-09-25、親の計測スクリプト observe_smooth.py)。

| devtools          | 修正前 p50                     | 修正後 p50 (2 回) |
| ----------------- | ------------------------------ | ----------------- |
| dev サーバー      | 3.1 ms (親の計測では -1.6 ms)  | 51.8 ms、51.4 ms  |
| 配備 (本番ビルド) | 52.0 ms (親の計測では 29.2 ms) | 51.7 ms、57.6 ms  |

修正後は dev サーバーと配備がほぼ一致する。キーフレームを publisher の encoder の出力と subscriber の受信で突き合わせて内訳を出した (各 11 枚の中央値)。

| devtools              | TIMESTAMP -> encoder の出力 | encoder の出力 -> 受信 | TIMESTAMP -> 受信 |
| --------------------- | --------------------------- | ---------------------- | ----------------- |
| dev サーバー (修正前) | -47.2 ms                    | 56.7 ms                | 9.5 ms            |
| dev サーバー (修正後) | 3.3 ms                      | 50.7 ms                | 54.0 ms           |
| 配備 (修正後)         | 3.4 ms                      | 53.2 ms                | 56.6 ms           |

修正前は TIMESTAMP が encoder の出力より 47 ms 後になっており (撮る前に符号化したことになる)、最初のフレームを読むまでの遅れの分だけ未来にずれていた。修正後は TIMESTAMP から encoder の出力までが符号化の時間に見合う正の値になった。測定時の encoder の出力から受信までは約 51 から 53 ms で、見込み (20 から 40 ms) より大きいが、これは経路と relay の遅れであり換算の偏りではない。
