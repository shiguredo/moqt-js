# moqt-devtools の subscriber に受信から表示までの時間の統計が無く、映像のかくつきの原因を切り分けられない

- Created: 2026-09-25
- Completed: 2026-09-25
- Branch: feature/add-devtools-playback-timing-stats
- Polished: {YYYY-MM-DD}

## 目的

配備環境の moqt-devtools で受信側の映像がかくつく。Playwright で main thread の時刻を記録して測ると (2026-09-25、1280x720 / 30 fps / 2 Mbps、60 秒)、表示間隔が 50 ms を超えた回数が 99 回 (合計 7.5 秒) あり、到着の遅れは p99 で 1 秒を超えた。

devtools の subscriber は受信・復号・表示の累積カウンタしか出さないため、画面を見てもかくつきの原因 (到着の揺らぎ、送信から受信までの遅延、復号の遅れ、表示の止まり、表示キューのあふれ) を区別できない。表示キューがあふれて捨てたフレームはどこにも数えていない。受信から表示までの時間の統計を出し、画面と `window.moqtDevTools` から原因を切り分けられるようにする。

## 現状

- `devtools/src/signals/subscriber.ts` の `SubscriberInstance` の統計は `framesDecoded` / `objectsReceived` / `chunksDecoded` / `staleFramesDropped` などの累積カウンタだけである
- `devtools/src/hooks/useSubscriber.ts` の `presentFrame` は表示待ちのキューが `MAX_PENDING_FRAMES` を超えると古いフレームを `close()` して捨て、数えない
- `drawFrame` は描いた数 (`framesDecoded`) だけを数え、描いた時刻を記録しない
- `handleObject` は到着した Object の LOC TIMESTAMP を EncodedVideoChunk の timestamp にするが、到着時刻との関係を記録しない

## 設計方針

- 統計の計算はブラウザ API に依存しない純粋なモジュール (`devtools/src/utils/playbackTimingStats.ts`) に集約し、時刻は引数で受ける。直近の窓 (10 秒) の分布と、配信開始からの累積を持つ
- 指標
  - 到着の揺らぎ: 到着時刻 - メディア時刻 (LOC TIMESTAMP) の、窓の中の最小値からの差の p50 / p95 / max。時計のずれに依らない
  - 遅延: 壁時計 - LOC TIMESTAMP の p50 / p95 / max。Timescale が無い (壁時計の) TIMESTAMP だけで求める。送信側の時計を基準にするため、別のマシンでは時計のずれを含む (UI に明記する)
  - 復号時間: decoder に渡してから出力されるまでの p50 / p95 / max。timestamp で対応づける
  - 表示間隔の p50 / p95 / max と直近 1 秒の表示 fps
  - 表示の止まり: 表示間隔がフレーム間隔 (描いたフレームのメディア時刻の差の中央値) の 1.5 倍を超えた回数と、その表示間隔の合計 (累積)
  - 表示キューがあふれて捨てたフレーム数 (累積)
- `useSubscriber` の到着 (`handleObject`)、復号の開始と出力、`presentFrame` のあふれ、`drawFrame` の表示で記録し、購読開始、decoder の configure / reconfigure、停止でリセットする
- signal への反映は一定間隔 (500 ms) で行い、フレームごとに再描画させない
- `SubscriberPanel` と `DebugPanel` に表示し、`window.moqtDevTools.getSubscribers()` に出す

## 完了条件

- 各指標の計算を単体テストで固定し、窓の外の値を含めないこと・累積の値が減らないことなどを PBT で固定する
- `SubscriberPanel` / `DebugPanel` / `window.moqtDevTools.getSubscribers()` に統計が出る
- 配備した devtools で `getSubscribers()` に統計が出ることを確かめる
- `vp check` と全テストが通る

## 解決方法

- `devtools/src/utils/playbackTimingStats.ts` を足した。`PlaybackTimingStats` は到着 (`recordArrival`)、復号の開始と出力 (`recordDecodeStart` / `recordDecodeOutput`、timestamp で対応づける)、表示 (`recordDisplay`)、表示キューのあふれ (`recordQueueDrop`) を時刻つきで記録し、`snapshot` で直近 10 秒の分布 (nearest-rank 法の p50 / p95 / max) と累積の値を返す。時刻は引数で受け、ブラウザ API に依存しない
  - `arrivalJitterMs`: 到着時刻 - LOC TIMESTAMP の、窓の中の最小値からの差
  - `latencyMs`: 受信側の壁時計 - 送信側の壁時計の LOC TIMESTAMP (Timescale の無い TIMESTAMP だけ)
  - `decodeTimeMs`: decoder に渡してから出力されるまで
  - `displayIntervalMs` / `displayFps` (直近 1 秒)
  - `displayStalls` / `displayStallMs`: 表示間隔がフレーム間隔 (描いたフレームのメディア時刻の差の中央値) の 1.5 倍を超えた回数とその表示間隔の合計 (累積)
  - `displayQueueDrops`: 表示キューがあふれて捨てたフレーム数 (累積)
- `buildVideoChunkPlan` は TIMESTAMP の種類 (`timestampKind`: `wallClock` / `mediaTime` / `none`) を返し、`wallClock` のときだけ遅延を求める
- `useSubscriber` の `handleObject` (到着と復号の開始)、decoder の出力、`presentFrame` のあふれ、`drawFrame` で記録する。購読の開始で初期化して 500 ms ごとに `SubscriberInstance.playbackTiming` へ反映し、停止で記録を止める (signal には最後の値を残し、次の購読の開始で初期化する)
- `SubscriberPanel` に Playback Timing の欄 (`data-testid` つき)、`DebugPanel` の統計のテキストに Playback Timing を足し、`window.moqtDevTools.getSubscribers()` の `playbackTiming` に出す
- テスト: 百分位の定義・到着の揺らぎと遅延・窓の外の値を含めないこと・復号時間の対応づけ・止まりの判定・表示 fps・リセット (`playbackTimingStats.test.ts`)、窓の中の値だけから求めること・時計のずれに依らないこと・累積の値が減らないこと・フレーム間隔どおりなら止まりが 0 であること (`playbackTimingStats.prop.ts`)、`timestampKind` (`useSubscriber.test.ts`)、`resetSubscriberStats` と `buildSubscriberStats` (`useSubscriber.test.ts` / `testApi.test.ts`)
- `vp check` と全テスト (129 ファイル / 2648 件)、devtools の Playwright E2E (`devtools-audio-meter.spec.ts` / `devtools-audio.spec.ts`) が通った

配備した devtools (配備 relay、1280x720 / 30 fps / 2 Mbps、同じマシンの publisher と subscriber、購読開始から約 24 秒) で `getSubscribers()` に次の値が出た。

- `latencyMs`: p50 35.3 / p95 76.6 / max 205.5 ms (同じマシンのため時計のずれは無い。映像の TIMESTAMP を壁時計で送るようにした後の値)
- `arrivalJitterMs`: p50 10.9 / p95 52.3 / max 181.2 ms
- `decodeTimeMs`: p50 1.9 / p95 2.5 / max 3.5 ms
- `displayIntervalMs`: p50 33.3 / p95 49.9 / max 200.1 ms、`displayFps` 30
- `displayStalls` 38 回、`displayStallMs` 2509 ms、`displayQueueDrops` 0

復号時間と表示キューは原因ではなく、表示の止まりは到着の揺らぎに由来する。表示をメディア時刻に合わせて揺らぎを吸収する (jitter buffer) 対応は本 issue の範囲外である。
