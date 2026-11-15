# webkit-playout の実時間メディア判定に残る実行環境依存の失敗をなくす

- Created: 2026-11-15
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-webkit-playout-residual-flake
- Polished: 2026-11-15

## 目的

CI の webkit-playout ジョブが、実装の退行ではなく実行環境の停止で失敗して develop を赤くするのをなくす。2026-11-10 に実行環境の停止を外部で測って判定から切り分ける仕組みを入れてから失敗は大きく減ったが、映像の表示遅延と実メインスレッド停止の 2 系統が残っている。

## 現状

- 切り分けの導入前は、2026-11-09 から 2026-11-10 までの develop 13 run 中 5 run が webkit-playout で失敗していた。導入後は 2026-11-15 までの 77 run 中 2 run まで減ったが、0 にはなっていない
- 2026-11-14 の run 43572434606 では、`tests/e2e/audio-render-processor.spec.ts` の「出力側は 60 ms の実メインスレッド停止を補間する」が `maximumZeroMs` 36.02 ms で失敗した。メインスレッドを 60 ms 止めている間、`AudioWorklet` の処理が止まった疑いがあり、`maximumZeroMs < 0.5` の判定に掛かった。テストはメインスレッドの停止時間だけを記録しており、音声スレッドが同じように飢餓したかを測っていない
- 2026-11-14 の run 43579331917 では、`tests/e2e/media-subscriber-element-playback.spec.ts` の 180 ms 停止のケースで、id 14 の表示だけが 191 ms 遅れた。表示時刻は `VideoFrameRequestCallback` の `expectedDisplayTime`、乱れの判定は `outputLagMaxMs` と意図しない飛ばしで行っている。この回は `outputLagMaxMs` が 5 ms で `disturbed` が false のため測り直されず、`AGE_LIMIT_MS` (150 ms) の判定で 1 回目の測定のまま失敗した。id 14 は解像度変更 (供給の index 120) の直後のパルスである
- `timingFailures` は「その回が乱れていた」(`disturbed`) ときだけ測り直す。`disturbed` は `AudioContext` の時計の遅れと意図しない飛ばしで決まるため、映像のエンコーダー、コンポジター、表示待ちの停止は乱れた回として扱われない。映像の表示遅延が実行環境の停止で説明できるかを示す信号が無いことが残件の原因である
- `tests/e2e/audio-render-processor.spec.ts` の実時計のテストは、`AudioWorklet` が投稿するブロックの `frame` を記録しているが、投稿の間隔と `currentFrame` の連続性から音声スレッドの飢餓を判定していない

## 設計方針

- assert や許容値を緩めない。失敗した回が実行環境の停止で説明できるかを、追加の観測で示す
- 映像: 表示遅延が「フレームの供給遅れ」「コンポジターの停止」「表示待ち」のどれかを切り分ける信号を足す。`VideoFrameRequestCallback` の `presentedFrames`、`processingDuration`、`expectedDisplayTime` とコールバック時刻の差、`mediaTime` の進みを記録する。停止を検出した回だけ測り直し、検出していない回は今までどおり失敗させる
- 音声: メインスレッドを止めている間の `AudioWorklet` の進行を、投稿されたブロックの `frame` の連続性と `AudioContext` の時計で測る。音声スレッドが飢餓した回だけ測り直す。飢餓していないのに出力が 0 のままなら実装の退行として扱う
- まず 2026-11-14 の artifact と、macOS の WebKit で負荷をかけた実行で原因を確定させてから、信号の種類と閾値を決める。推測で判定を緩めない
- 観測の追加は webkit-playout のテストに閉じ込め、製品コードの判定には使わない

## 完了条件

- 2026-11-14 に失敗した 2 系統それぞれに、実行環境の停止を検出する観測が入っている。停止を検出した回は測り直し、検出していない回は失敗する
- macOS の WebKit で `--repeat-each` を付けて複数回実行し、音声スレッドの飢餓と映像の表示停止が起きていない回で判定が成り立つことを確認している
- `vp check` / `vp exec tsc --noEmit` / `vp test run` が通る
- 修正後、develop の webkit-playout が複数 run 連続で成功することを確認している

## 参照

- `tests/e2e/media-subscriber-element-playback.spec.ts` の `timingFailures` / `observeElementPlayback` / `AGE_LIMIT_MS` / `CLOCK_JITTER_MS` / `outputLag`
- `tests/e2e/audio-render-processor.spec.ts` の「出力側は 60 ms の実メインスレッド停止を補間する」
- `.github/workflows/ci.yml` の `webkit-playout` ジョブ
- `docs/PLAYOUT_REDESIGN_REVIEW.md` の「実行環境の乱れの切り分け」
- 失敗した run: https://github.com/shiguredo/moqt-js/actions/runs/43572434606 / https://github.com/shiguredo/moqt-js/actions/runs/43579331917
- closed `0811-test-e2e-flaky-tests.md` / closed `0886-test-stabilize-flaky-ci-tests.md` / open `0949-bug-audio-clock-render-stall.md`
