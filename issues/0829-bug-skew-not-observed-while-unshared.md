# 基準の共有を解除している間、音声と映像の表示時刻の差が観測できない

- Created: 2026-10-11
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-skew-observation-while-unshared
- Polished: {YYYY-MM-DD}
- Reporter: @voluntas

## 目的

基準の共有を解除している間 (映像を音声の到着基準へ落としたフォールバックの間) は、利用者に見えるリップシンクの指標 `avSync.skewMs` が作られない。解除が長引く環境では、実リレーの E2E がこの指標を確かめられないまま通る (実測: CI の run 38048874698 では、保持 (hold) が観測の 25 秒間続き、25 回すべて null だった)。原因を特定し、表示が止まっているなら直し、指標の条件であるなら仕様として明記する。

## 現状

- `skewMs` は `src/playbackTimeline.ts` の `skewMs()` が返す。音声と映像それぞれの「直近に表示した実績」の時刻が `SKEW_SAMPLE_WINDOW_MS` (1 秒) 以内にあるときだけ値を返し、どちらかが古いと null になる
- 実績は表示のたびに記録する。音声は `src/audioPlayoutSession.ts` の `recordPresentation` (壁時計の TIMESTAMP と鳴らす時刻がどちらも引けるとき)、映像は `src/videoPlayoutSession.ts` の `drain()` (`selection.drawPresentationMs !== null` のときだけ) である
- 映像の表示時刻は `src/playoutBuffer.ts` の `presentationTimeMs` が共有の時間軸から引く。共有できないときは到着基準へ落ちる設計であり (closed の 0635)、フォールバック中もフレームは表示される想定である。どの条件で実績が作られなくなるかは特定していない
- 実リレーの E2E `tests/e2e/relay/audio-timestamp.spec.ts` は、共有が戻った後に `skewMs` が観測できることを見る。解除中の値は判定に使っていない
- 実測 (CI の 4 vCPU の runner): run 38048874698 (音声の基準の遅れ 154.0 ms / 映像 148.4 ms) と run 38099573874 (同 150.0 ms / 143.7 ms) は、解除した保持が観測の 25 秒間続き、`skewMs` が 25 回すべて null だった。この間、基準の差は 3.2〜6.5 ms で安定し、復号した音声 Chunk の数も増え続けていた

## 設計方針

1. 解除中に実績が作られない側を特定する。音声は壁時計の TIMESTAMP と鳴らす時刻、映像は表示時刻のどちらで落ちているかを見る。手元では解除が起きないため、メインスレッドを止める負荷をかけた状態で devtools の統計を観測する
2. 特定した結果で分岐する
   - フレームは表示されているが実績だけ作られない場合: 実績を記録する条件を直し、解除中も `skewMs` が観測できるようにする
   - フレームが表示されていない場合: 解除中も表示を続けるよう直す (利用者に見える不具合)
   - 解除中は値を返さないのが仕様である場合: `skewMs()` と `docs/` に理由を明記し、E2E の判定をそれに合わせる
3. 判定は実リレーの E2E に固定する。解除が戻るまでの間を含めて `skewMs` が観測できること (解除中の値を予算で判定するかは 2 の結論で決める)

## 完了条件

- 解除中に `skewMs` が作られない原因 (どちらの実績が、どの条件で落ちるか) が特定され、issue に記録されていること
- 原因に応じて実装を直すか、解除中は値を返さない仕様であることをコメントと docs に明記すること
- 解除中の挙動を固定する単体テスト (`src/playbackTimeline.test.ts` または `src/videoPlayoutSession.test.ts`) が追加されていること
- `vp check` / `vp test run` が通り、実リレーが使える環境で `vp run e2e-test:relay` が通ること

## 参照

- `src/playbackTimeline.ts` の `skewMs()` / `SKEW_SAMPLE_WINDOW_MS` / `unsharedReason()` / `PLAYOUT_BASE_UNSHARED_HOLD_MS` / `PLAYOUT_BASE_UNSHARED_RELEASE_MS`
- `src/audioPlayoutSession.ts` の `recordPresentation` / `src/videoPlayoutSession.ts` の `drain()` と `handleDecodedFrame` / `src/playoutBuffer.ts` の `presentationTimeMs` と `framePresentationMs`
- `src/codec/types.ts` の `AvSyncStats.skewMs` / `devtools/src/hooks/useSubscriber.ts` の `avSync.skewMs`
- `tests/e2e/relay/audio-timestamp.spec.ts` の `expectSkewWithinBudget`
- closed の 0635 (共有できないときのフォールバックと `skewMs` の定義) / 0754 (音声の TIMESTAMP のドリフト)
