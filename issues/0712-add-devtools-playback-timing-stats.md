# moqt-devtools の subscriber に受信から表示までの時間の統計が無く、映像のかくつきの原因を切り分けられない

- Created: 2026-09-25
- Completed: {YYYY-MM-DD}
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
