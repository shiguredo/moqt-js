# devtools の subscriber が relay の cache から追いつく途中の古い映像を描き、音声は鳴らすかどうかを推定で決めている

- Created: 2026-09-25
- Completed: {YYYY-MM-DD}
- Branch: feature/update-devtools-hide-catch-up-frames
- Polished: 2026-09-27
- Reporter: @voluntas

## 目的

moqt-devtools の subscriber は、購読の開始に relay の cache から届いた古い Object (最新 Group の先頭から購読した時点まで) を、復号した順に映像へ描く。これらは実時間より速く届くため、表示は早送りになる。closed の `0723` の配備 relay の実測では、cache から届くフレームは実時間の約 2 倍の速さで届いていた。キーフレームの間隔が長い配信 (例: 90 秒) では、何十秒も前の映像を早送りで見せ続けることになり、見る人には意味が無い。描画の負荷もかかる。

音声は、cache から届いた分かどうかではなく、鳴らす時刻を過ぎているか (jitter buffer が有効で TIMESTAMP が壁時計のとき) と並べすぎの上限で、鳴らすか捨てるかを決めている。cache から届いた分は実時間より速く届くため、この推定に任せると、無音になるか、到着順に今 + 再生の遅れから並べて鳴らすかが、設定と届き方で変わる。どちらも購読の開始のたびに起きる、見る人にとって意味の無い再生である。

利用者から「早送り最中は再生しない方がよいのではないか」と提案があった。追いつく途中の映像は、参照のために復号はするが描かない。音声も復号はするが鳴らさない。どちらも、後述の境界を越えた位置の Object から再生を始める。

## 現状

- `devtools/src/hooks/useSubscriber.ts` の `presentFrame` は、復号したフレームをすべて表示待ちのキュー (`PlayoutBuffer`) へ積む。jitter buffer が有効なら表示時刻を過ぎた古いフレームを捨てながら最新を描き、無効なら表示周期ごとに 1 枚ずつ描く。どちらも追いつく途中は早送りに見える
- `devtools/src/hooks/useSubscriber.ts` の `handleAudioDecoded` は、復号した音声の鳴らす時刻を `AudioPlayoutScheduler` に決めさせる。jitter buffer が有効で TIMESTAMP が壁時計のときは、目標の時刻を過ぎた音と並べすぎの音を捨てる (鳴らない分ができる)。jitter buffer が無効、または TIMESTAMP が壁時計でないときは、届いた順に今 + 再生の遅れから並べ、並べすぎの上限 (`AUDIO_PLAYOUT_BACKLOG_SECONDS`。`AUDIO_PLAYOUT_MAX_DELAY_SECONDS` から `AUDIO_PLAYOUT_DELAY_SECONDS` を引いた 0.22 秒) まで溜まった分が鳴ってから捨てられる。どちらも、鳴らすかどうかの判断に cache から届いた分かどうかを使っていない
- `src/playbackTimeline.ts` の `PlaybackTimeline.isCatchingUp` は、再生遅延の学習から追いつき中の遅れを除くためだけに使い (`observe` からの呼び出し)、表示は止めない。判定には `observe` が更新する遅れの推移を使うため、jitter buffer が無効なときや TIMESTAMP が壁時計でないときは使えない
- `devtools/src/hooks/useSubscriber.ts` の `startSubscribing` は映像トラックの SUBSCRIBE_OK の LARGEST_OBJECT (`subscriberInstance.largestLocation`) を読んで表示するだけで、再生には使っていない。音声トラックの LARGEST_OBJECT は読んでもいない

## 設計方針

- draft-ietf-moq-transport-21 Section 9.20.18 の LARGEST_OBJECT は、購読した時点で publisher (relay) が持っていた最新の位置である (Object が publish されていれば必須)。この位置以前の Object は購読より前の分 (relay の cache から配られたもの) であり、この位置より後の Object から live である。これを追いつきの境界にする。推定を使わないため、jitter buffer の設定や TIMESTAMP の種類に依らない
- 境界以前の位置の映像フレームは、参照のために復号するが描かない (`presentFrame` で閉じる)。境界より後の位置のフレームから、従来どおり表示待ちのキューへ積む
- 境界以前の位置の音声は、`handleAudioDecoded` で復号の出力の位置を引いて判定し、復号はするが鳴らさない。Audio Config (draft-ietf-moq-loc-04 Section 2.3.3.1) は Object ごとに運ばれ (同 Section 2.3)、値が変わったときだけ載るため (devtools の publisher も同じ)、cache から届いた分の復号を飛ばすと適用を落とすことがある。境界より後の位置の Object から、従来どおり `AudioPlayoutScheduler` で鳴らす
- 映像と音声は別の Track であり、SUBSCRIBE_OK が返す LARGEST_OBJECT も別である。境界は Track ごとに持ち、音声だけの購読でも同じ判定を使う
- 復号へ渡すときにフレームと音声の位置 (Group ID / Object ID) を TIMESTAMP で引けるように覚え、復号の出力で境界と比べる。SUBSCRIBE_OK より前に届いた Object も、復号の出力の時点では境界が分かっている
  - TIMESTAMP を持たない Object は同じ TIMESTAMP (0) を共有し、同じ TIMESTAMP の Object が重なったときはどちらの位置か決められない。位置を一意に引けない Object は覚えず、復号の出力では位置が分からないものとして扱い、境界の判定をせずに従来どおり描く・鳴らす。この分は境界以前でも再生されうる (TIMESTAMP を載せない publisher、または同じ TIMESTAMP の Object を送る publisher の購読で起きる)
  - 位置が分からないままでは境界を越えられないため、その Track の「Catching up」は位置が分からない最初の出力で終える (判定できないまま出し続けない)
- LARGEST_OBJECT が無い (購読の時点で Object が無い) ときは、すべてのフレームと音声を再生する
- 描かなかったフレームの数を `catchUpFramesSkipped`、鳴らさなかった音声 Object の数を `audio.catchUpObjectsSkipped` として統計に出し、画面と `window.moqtDevTools.getSubscribers()` に出す。音声の数は再生が有効なときだけ数える
- 境界を越えて最初のフレームを描いたときと、境界を越えて最初の音声 Object を復号したときに、デバッグログに残す。映像と音声の両方が境界を越えるまでは、画面に「Catching up」を出す
- 対象は `devtools/src/hooks/useSubscriber.ts`、境界の判定の純モジュール (`devtools/src/utils/catchUpGate.ts` を新設)、統計 (`devtools/src/signals/subscriber.ts` / `devtools/src/signals/statsSnapshot.ts`)、画面 (`devtools/src/components/SubscriberPanel.tsx`) とする

## 完了条件

- 境界の判定の単体テストと PBT (Group ID と Object ID の辞書順で境界以前を判定する)
- cache から届く Object 列を模した入力で、境界を越えるまでは再生せず、越えたら再生し、越えたことを 1 回だけ知らせることをテストで固定する (映像と音声は同じ判定を使う)
- sora-moq (Sora の Media over QUIC 実装であり、リレー機能を提供する) の相互運用 harness (`e2e-test/browser/relay_interop/`。`make browser-test-moqtjs-devtools` で実行する) で、cache から追いつく購読の `window.moqtDevTools.getSubscribers()` を読み、`catchUpFramesSkipped` が 1 以上であること、`catchUpPending` が true から false に変わること、`framesDecoded` が境界を越えた後に 1 以上になること、`audio.catchUpObjectsSkipped` が 1 以上になること (音声は再生を有効にした購読で確かめる) を確かめる
- `vp check` / `tsc --noEmit` / `vp test run` が通る
