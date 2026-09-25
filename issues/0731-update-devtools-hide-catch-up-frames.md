# devtools の subscriber が relay の cache から追いつく途中の古いフレームも描き、早送りの映像を見せる

- Created: 2026-09-25
- Completed: {YYYY-MM-DD}
- Branch: feature/update-devtools-hide-catch-up-frames
- Polished: {YYYY-MM-DD}
- Reporter: @voluntas

## 目的

moqt-devtools の subscriber は、購読の開始に relay の cache から届いた古いフレーム (最新 Group の先頭から購読した時点まで) を、復号するたびに描く。これらは実時間より速く届くため、表示は早送りになる。キーフレームの間隔が長い配信 (例: 90 秒) では、何十秒も前の映像を早送りで見せ続けることになり、見る人には意味が無い。描画の負荷もかかる。

利用者から「早送り最中は再生しない方がよいのではないか」と提案があった。追いつく途中のフレームは、参照のために復号はするが描かず、live に追いついてから表示を始める。

## 現状

- `devtools/src/hooks/useSubscriber.ts` の `presentFrame` は、復号したフレームをすべて表示待ちのキュー (`PlayoutBuffer`) へ積む。jitter buffer が有効なら表示時刻を過ぎた古いフレームを捨てながら最新を描き、無効なら表示周期ごとに 1 枚ずつ描く。どちらも追いつく途中は早送りに見える
- `devtools/src/utils/playoutBuffer.ts` の追いつき中の判定 (`isCatchingUp`) は、再生遅延の学習から追いつき中の遅れを除くためだけに使い、表示は止めない。判定には遅れの推移を使うため、jitter buffer が無効なときや TIMESTAMP が壁時計でないときは使えない
- `startSubscribing` は映像トラックの SUBSCRIBE_OK の LARGEST_OBJECT (`subscriberInstance.largestLocation`) を読んで表示するだけで、再生には使っていない

## 設計方針

- draft-ietf-moq-transport-21 Section 9.20.18 の LARGEST_OBJECT は、購読した時点で publisher (relay) が持っていた最新の位置である。この位置までの Object は購読より前の分 (relay の cache から配られたもの) であり、この位置より後の Object から live である。これを追いつきの境界にする。推定を使わないため、jitter buffer の設定や TIMESTAMP の種類に依らない
- 境界以前の位置のフレームは、参照のために復号するが描かない (`presentFrame` で閉じる)。境界より後の位置のフレームから、従来どおり表示待ちのキューへ積む
- 復号へ渡すときにフレームの位置 (Group ID / Object ID) を TIMESTAMP で引けるように覚え、復号の出力で境界と比べる。SUBSCRIBE_OK より前に届いた Object も、出力の時点では境界が分かっている
- LARGEST_OBJECT が無い (購読の時点で Object が無い) ときは、すべてのフレームを描く
- 描かなかったフレームの数を `catchUpFramesSkipped` として統計に出し、画面と `window.moqtDevTools.getSubscribers()` に出す。境界を越えて最初のフレームを描いたらデバッグログに残す
- 追いついて描くまでの間は、画面に「Catching up」を出す

## 完了条件

- 境界の判定の関数の単体テストと PBT (Group ID と Object ID の辞書順で境界以前を判定する)
- sora-moq の相互運用 harness の E2E で、cache から追いつく購読が境界以前のフレームを描かずに数え、境界より後のフレームを描くことを確かめる
- `vp check` / `tsc --noEmit` / `vp test run` が通る
