# moqt-devtools が遅延を区間ごとに出さず、遅延が moqt-js と sora-moq (経路) のどちらで生じたか分からない

- Created: 2026-09-25
- Completed: 2026-09-25
- Branch: feature/add-devtools-latency-breakdown-stats
- Polished: {YYYY-MM-DD}

## 目的

moqt-devtools でカメラの映像の遅延が大きいとき、利用者は sora-moq (relay) が遅らせているのか moqt-js (moqt-devtools) が遅らせているのかを判断できない (2026-09-25、利用者の要望)。devtools が出す遅延は到着の遅延 (`latencyMs`、LOC TIMESTAMP から受信まで) だけで、publisher の中と subscriber の中の遅れを出さない。

2026-09-25 の計測では、到着の遅延は約 50 ms だったが、表示の遅延 (読んでから描くまで) は購読の開始の直後に約 500 ms あり、差の大部分は subscriber の jitter buffer の待ちだった。この切り分けは、ブラウザの外からフックを差し込んで測ってようやく分かった。devtools の統計だけで同じ切り分けができるようにする。

## 現状

- `devtools/src/hooks/usePublisher.ts` の `processFrames` はフレームを読んだ時刻を `WallClockMapper` に記録するだけで、フレームごとに符号化 (読んでから encoder の出力まで) と送信 (`Publisher.sendObject` の完了まで) にかかった時間を記録しない。`encodeQueueSize` が 2 を超えて符号化せずに捨てたフレームも数えない
- `devtools/src/utils/playbackTimingStats.ts` の `PlaybackTimingSnapshot` は、到着の遅延 (`latencyMs`)、到着の揺らぎ、復号時間、再生遅延を出す。Group の切り替えの保留で待った時間、復号してから描くまでの待ち (jitter buffer)、読んでから描くまでの全体 (表示の遅延) は出さない
- publisher の LOC TIMESTAMP はフレームを読んだ時刻の壁時計である (draft-ietf-moq-loc-04 Section 2.3.1.1)。publisher と subscriber が同じマシンなら、subscriber は TIMESTAMP との差で、読んでから到着・描くまでの時間を時計のずれなしに測れる。別のマシンでは時計のずれを含む
- Chromium (151) の `WebTransport` には `getStats()` が無く、ブラウザから経路の RTT を取れない。経路と relay の遅れを分けるには relay 側の計測が要る (sora-moq 側の対応)

## 設計方針

区間を次のように分け、それぞれの p50 / p95 / max を直近の窓で出す (`TimingSummary`)。

publisher (`window.moqtDevTools.getPublisher()` と publisher の画面):

- 符号化: フレームを読んでから encoder の出力まで (encoder の待ちを含む)
- 送信: encoder の出力から `sendObject` の完了 (WebTransport の stream への書き込みの完了) まで
- `encodeQueueSize` の超過で符号化せずに捨てたフレームの数 (累積)

subscriber (`window.moqtDevTools.getSubscribers()` と subscriber の画面):

- 到着の遅延 (既存): TIMESTAMP から受信まで。publisher の符号化と送信、経路、relay を含む
- 保留: 受信から復号に渡すまで (Group の切り替えの保留)
- 復号 (既存)
- 表示の待ち: 復号の出力から描くまで (jitter buffer の待ち)
- 表示の遅延: TIMESTAMP から描くまで (上の合計)

- 区間の合計が表示の遅延になるよう、同じフレームの時刻で区間を測る。どの区間が大きいかで、publisher (moqt-js)、経路 + relay、subscriber (moqt-js) のどれで遅れたかが分かる
- TIMESTAMP を使う区間 (到着の遅延と表示の遅延) には、別のマシンでは時計のずれを含むことを画面と統計の説明に書く
- 区間の記録は既存の `PlaybackTimingStats` と同じく、ブラウザ API に依存しない純粋なモジュールに置き、時刻は引数で受ける

## 完了条件

- 区間の記録と要約を単体テストと PBT で固定する (区間の合計が表示の遅延と一致すること、窓から外れた記録を捨てること)
- publisher の符号化と送信の区間、捨てたフレームの数を単体テストで固定する
- 画面と `getPublisher()` / `getSubscribers()` に区間が出ることをテストで確かめる
- 配備 relay で、jitter buffer 有効の購読の開始の直後に「表示の待ち」が大きく、到着の遅延は小さいことが統計だけで読み取れることを確かめる
- `vp check` と全テスト (vitest) が通る

## 解決方法

- `devtools/src/utils/latencyBreakdown.ts` (新規) の `LatencyBreakdown` が、フレームごとに受信・保留を出た・decoder に渡した・出力の時刻を TIMESTAMP で対応づけ、描いたときに区間 (`arrival` / `hold` / `decodeWait` / `decode` / `displayWait` / `displayLatency`) の時間を直近の窓に加える。時刻が揃わないフレームは加えないため、フレームごとに区間の和が表示の遅延になる。描かなかったフレームの時刻は窓を過ぎたら捨てる。`arrival` と `displayLatency` は壁時計の TIMESTAMP のフレームだけで求める
- `devtools/src/utils/playbackTimingStats.ts` の `PlaybackTimingStats` が既存の記録の呼び出し (`recordArrival` / `recordObjectReleased` / `recordDecodeStart` / `recordDecodeOutput` / `recordDisplay`) から `LatencyBreakdown` を更新し、`latencyBreakdown` (区間ごとの p50 / p95 / max) を統計に出す
- `devtools/src/utils/publishTimingStats.ts` (新規) の `PublishTimingStats` が、フレームを読んだ時刻、encoder の出力、`sendObject` の完了を VideoFrame の timestamp で対応づけ、符号化 (`encodeMs`) と送信 (`sendMs`) の時間と、`encodeQueueSize` の超過で捨てたフレームの数 (`encodeQueueDrops`) を出す。`devtools/src/hooks/usePublisher.ts` が記録し、encoder の出力を受けたときに 0.5 秒おきに `publishTiming` へ反映する
- publisher と subscriber の画面に Latency Breakdown を足し、`window.moqtDevTools.getPublisher()` に `publishTiming` を足した。DebugPanel の統計のテキストにも出す。TIMESTAMP を使う区間は別のマシンでは時計のずれを含むことを画面の説明に書いた
- テスト: `LatencyBreakdown` の単体テスト (区間の値、壁時計でないフレーム、時刻が揃わないフレーム、窓、reset) と PBT (フレームごとに区間の和が表示の遅延と一致し、負にならない)、`PublishTimingStats` の単体テスト、`PlaybackTimingStats` の統計に区間が出るテスト、画面と `window.moqtDevTools` に項目が出る E2E (`tests/e2e/devtools-latency-breakdown.spec.ts`)。`vp check` と全テスト (2759 件) が通った

配備 relay で、修正した手元の devtools を使って偽カメラ (20 fps) を 20 秒購読し、devtools の統計と外から測った値 (publisher と subscriber を同じ Chromium で開き、フックで測った値) を比べた (p50):

| 区間                                                      | devtools の統計 | 外から測った値             |
| --------------------------------------------------------- | --------------- | -------------------------- |
| publisher の符号化                                        | 1.4 ms          | 1.4 ms                     |
| publisher の送信                                          | 0.3 ms          | -                          |
| subscriber の到着 (publisher の符号化と送信、経路、relay) | 45.6 ms         | 45.6 ms                    |
| subscriber の保留 / 復号待ち                              | 0 ms / 0 ms     | -                          |
| subscriber の復号                                         | 1.4 ms          | 1.4 ms                     |
| subscriber の表示待ち (jitter buffer)                     | 12.2 ms         | -                          |
| subscriber の表示の遅延                                   | 58.9 ms         | 57.6 ms (drawImage の時刻) |

この回は、遅延の大半 (約 44 ms) が経路と relay で、moqt-js の中は publisher 約 2 ms、subscriber 約 14 ms だった。経路と relay (sora-moq) の中の内訳は、relay 側で Object を留めた時間を測らないと分けられない (sora-moq 側の対応)
