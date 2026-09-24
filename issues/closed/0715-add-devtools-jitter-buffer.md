# moqt-devtools の subscriber が復号したフレームを到着のタイミングのまま表示し、到着の揺らぎで映像がかくつく

- Created: 2026-09-25
- Completed: 2026-09-25
- Branch: feature/add-devtools-jitter-buffer
- Polished: {YYYY-MM-DD}

## 目的

配備環境の moqt-devtools で受信側の映像がかくつく。受信から表示までの時間の統計 (`playbackTiming`) で測ると (2026-09-25、配備 relay、1280x720 / 30 fps / 2 Mbps)、表示間隔が 50 ms を超える止まりが 60 秒で約 90 回あり、到着の揺らぎ (`arrivalJitterMs`) の p95 は約 50 ms だった。復号時間 (p95 約 2.5 ms) と表示キューのあふれ (0) は原因ではない。

devtools は復号したフレームを表示待ちのキューに積み、requestAnimationFrame ごとに 1 枚ずつ表示する。表示の時刻を決めるのは到着の時刻であり、到着の揺らぎがそのまま表示間隔の揺らぎになる。

LOC の TIMESTAMP は Timescale が無ければ Unix epoch のマイクロ秒 (壁時計) である (draft-ietf-moq-loc-04 Section 2.3.1.1)。devtools の publisher と `createMediaPublisher` は映像の TIMESTAMP を壁時計で送る。受信側はフレームの TIMESTAMP の間隔どおりに表示すれば、到着の揺らぎを吸収できる。

## 現状

- `devtools/src/hooks/useSubscriber.ts` の `presentFrame` は復号したフレームを `pendingFramesRef` に積み、`scheduleFrameDrain` が requestAnimationFrame ごとに先頭の 1 枚を描く。キューが `MAX_PENDING_FRAMES` (12) を超えると古い方から捨てる
- フレームの TIMESTAMP は表示の時刻に使っていない

## 設計方針

- 時刻の計算と表示するフレームの選択を、ブラウザ API に依存しない純粋なモジュール (`devtools/src/utils/playoutBuffer.ts`) に切り出す。時刻は引数で受ける
- 表示時刻 = フレームの TIMESTAMP + 基準の遅れ + 再生遅延とする
  - 基準の遅れ: 直近の窓 (10 秒) での「フレームが表示できるようになった時刻 (復号の出力) - TIMESTAMP」の最小値。送信側と受信側の時計のずれと、経路の最小の遅延を含む
  - 再生遅延: 窓の中の「フレームが表示できるようになった時刻 - TIMESTAMP - 基準の遅れ」(揺らぎ) の p95 を目標にする。目標が上がったら直ちに追従し、下がったときは一定の速さ (毎秒 20 ms) でゆっくり戻す。上限は 500 ms とし、表示待ちのキューの上限を超えない長さに抑える
  - 経路のまれな大きな遅延の跳ね (300 ms 前後、数分に数回) までは吸収しない。吸収すると常に 300 ms 以上遅れて表示することになるため
- requestAnimationFrame ごとに、表示時刻を過ぎたフレームのうち最新の 1 枚を描き、それより古いものは捨てて数える (間に合わなかったフレーム)。表示時刻前のフレームは待つ。フレームを並べ替えない
- TIMESTAMP が大きく飛んだ (2 秒以上) ときは基準を取り直す。publisher の時計の変更や別の publisher への切り替えで、全フレームが遅れる、または先の時刻で待ち続けることを避ける
- 表示待ちのキューの上限は 24 枚とし、あふれたら古い方から捨てる (従来と同じく `displayQueueDrops` に数える)
- Timescale のある TIMESTAMP と TIMESTAMP の無い Object は壁時計として使えないため、そのフレームは従来どおり届いた順に 1 枚ずつ表示する
- 設定 (Jitter Buffer) で無効にできるようにし、既定は有効にする。無効のときは従来どおりの表示にする。URL の `jitterBuffer=0` でも無効にできる
- 現在の再生遅延 (`playoutDelayMs`) と、間に合わずに捨てたフレーム数 (`lateFramesDropped`) を `playbackTiming` の統計、SubscriberPanel、DebugPanel、`window.moqtDevTools.getSubscribers()` に出す

## 完了条件

- 表示時刻の計算と選択を単体テストと PBT で固定する (揺らぎのある到着列で表示間隔が一定になること、再生遅延が上限を超えないこと、下げる速さが上限を超えないこと、フレームを並べ替えないこと、表示時刻より前に描かないこと)
- 設定の既定値と URL の往復をテストで固定する
- 配備した devtools と配備 relay で、有効時の `displayIntervalMs` の p95 と `displayStalls` が無効時より下がることを確かめる (1 回 60 秒、有効と無効を交互に 2 回ずつ)
- `vp check` と全テストが通る

## 解決方法

- `devtools/src/utils/playoutBuffer.ts` を足した。`PlayoutBuffer` は復号したフレームを積んだ順に保持し (並べ替えない)、requestAnimationFrame ごとの `select` で表示時刻を過ぎたフレームのうち最新を描き、それより古いものを間に合わなかったフレームとして返す。表示時刻前のフレームは待つ
  - 表示時刻 = TIMESTAMP + 基準の遅れ + 再生遅延。基準の遅れは直近 10 秒の「復号の出力の時刻 - TIMESTAMP」の最小値 (表示できる時刻には復号の時間も含まれるため、到着ではなく復号の出力で測る)
  - 再生遅延は揺らぎの p95 を目標にし、上がったら直ちに追従し、下がったら毎秒 20 ms で戻す。上限は 500 ms と、表示待ちのキューの上限 (24 枚) から余裕 4 枚を引いた枚数分のフレーム間隔の小さい方
  - 開始の後の最初のフレーム、前のフレームからフレーム間隔の半分より短い間隔で届いたフレーム (まとまって届いたフレーム)、上限を超える揺らぎは目標に使わない。最初の実装ではこれを除いておらず、購読の開始に relay の cache からまとめて届く古いフレーム (cache replay) を揺らぎとして学び、再生遅延が上限に張り付いて 20 秒以上戻らなかったため除いた
  - 遅れが基準から 2 秒以上離れたら TIMESTAMP の飛びとみなして基準を取り直し、積んでいたフレームは届いた順に表示する
  - 壁時計の TIMESTAMP を持たないフレームは届いた順に 1 回の選択で 1 枚ずつ表示する (従来の挙動)
- `devtools/src/hooks/useSubscriber.ts` の表示待ちのキューを `PlayoutBuffer` に置き換えた。購読の開始時の設定 (`jitterBufferEnabled`) で有効なら上限 24 枚、無効なら従来の 12 枚で作り、無効のときは全フレームを TIMESTAMP 無しとして積む (従来どおり)。decoder に渡したフレームの TIMESTAMP の種類を覚え、復号の出力で壁時計のフレームだけに表示時刻を使う
- 設定 `jitterBufferEnabled` (既定は有効) を足し、ConnectionSettings のチェックボックスと URL の `jitterBuffer=0` / `jitterBuffer=1` で切り替えられるようにした。Copy URL は無効のときだけ `jitterBuffer=0` を載せる
- `playbackTiming` に `playoutDelayMs` (現在の再生遅延、働いていなければ null) と `lateFramesDropped` (間に合わずに捨てた数) を足し、SubscriberPanel / DebugPanel / `window.moqtDevTools.getSubscribers()` に出した
- 窓の値を持つ `TimedValues` を `devtools/src/utils/timedValues.ts` に移し、統計と jitter buffer で共有した
- テスト: 表示時刻前は待つこと、最新を描いて古いものを捨てること、TIMESTAMP 無しは届いた順、キューのあふれ、再生遅延の追従と戻る速さ、上限を超える揺らぎと cache replay を学ばないこと、キューの上限による再生遅延の上限、TIMESTAMP の飛び、3 枚に 1 枚が 40 ms 遅れる到着で表示間隔が 1 フレーム ± 1 ms になること (`playoutBuffer.test.ts`)。並べ替えないこと、表示時刻前に描かないこと、再生遅延の範囲と下げる速さ、揺らぎの p95 が最大の揺らぎと一致する到着列で表示間隔が TIMESTAMP の間隔どおりになること (`playoutBuffer.prop.ts`)。設定の既定値と URL の往復 (`connectionSettings.test.ts`)、統計 (`playbackTimingStats.test.ts` / `testApi.test.ts`)
- `vp check`、全テスト (131 ファイル / 2670 件)、devtools の Playwright E2E が通った

配備した devtools と配備 relay で測った (2026-09-25、同じマシンの publisher と subscriber、1280x720 / 30 fps / 2 Mbps、購読開始の 5 秒後から 60 秒、有効と無効を交互)。表示間隔は main thread の drawImage の時刻から求め、止まりはフレーム間隔の 1.5 倍を超えた表示間隔である。

| 回 | jitter buffer | 表示間隔 p95 | 止まり (回 / 合計) | 250 ms 超の止まり | 間に合わずに捨てた数 | 再生遅延 (終了時) | 到着の揺らぎ p95 (直近 10 秒) |
|---|---|---|---|---|---|---|---|
| 1 | 有効 | 41.8 ms | 29 回 / 3233 ms | 3 | 5 | 184 ms | 241 ms |
| 1 | 無効 | 50.0 ms | 117 回 / 8173 ms | 5 | - | - | 182 ms |
| 2 | 有効 | 41.8 ms | 41 回 / 5446 ms | 2 | 1 | 201 ms | 261 ms |
| 2 | 無効 | 58.7 ms | 153 回 / 10918 ms | 1 | - | - | 39 ms |

- 2 回目の有効の測定の前に 1 回測ったが、測定中に relay が再配備されて配信が止まったため捨てて測り直した (上表の 2 回目)。上表の 2 回目の有効では、配信そのものが約 2 秒止まった区間 (約 50 Object が届かなかった) があり、止まりの合計時間に含まれる
- 無効 (1 回目の直後の同じ条件) の 1 回を別に測った値は、表示間隔 p95 50.0 ms、止まり 104 回 / 8595 ms だった
- 有効にすると止まりの回数は 1/3 から 1/4 になり、表示間隔の p95 は 41.8 ms (headless Chromium の requestAnimationFrame の刻み 8.3 ms (120 Hz) で 1 フレーム + 1 刻み) に収まる。経路のまれな大きな遅延の跳ね (250 ms 超) は設計どおり吸収しない
