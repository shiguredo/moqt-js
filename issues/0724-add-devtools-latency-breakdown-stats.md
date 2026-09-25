# moqt-devtools が遅延を区間ごとに出さず、遅延が moqt-js と sora-moq (経路) のどちらで生じたか分からない

- Created: 2026-09-25
- Completed: {YYYY-MM-DD}
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
