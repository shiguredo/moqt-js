# moqt-devtools の subscriber が復号したフレームを到着のタイミングのまま表示し、到着の揺らぎで映像がかくつく

- Created: 2026-09-25
- Completed: {YYYY-MM-DD}
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
