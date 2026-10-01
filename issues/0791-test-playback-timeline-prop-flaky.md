# playbackTimeline の表示時刻の差のプロパティテストがまれに失敗する

- Created: 2026-10-01
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-playback-timeline-prop-flaky
- Polished: {YYYY-MM-DD}

## 目的

表示時刻の差の許容 (50 ms) を固定するプロパティテストがまれに失敗し、レビューと CI を不安定にする。失敗する入力を特定して修正し、再発しないようにする。

## 現状

- `src/playbackTimeline.prop.ts` の「120 秒の到着列でも同時刻の表示時刻の差と skewMs が ±50 ms 以内になる」で、同時刻の表示時刻の差が 83.99 ms になる入力が観測された (レビュー中の実行で 1 回だけ失敗し、再実行では成功)
- 生成入力は fast-check のランダムであり、失敗した seed は記録されていない
- 許容 50 ms の根拠は同期の不感帯 (`SYNC_MIN_DELTA_MS` 30 ms) と同期のフィルタの説明に基づく (ファイル冒頭のコメント)

## 設計方針

- 失敗する seed と生成列を探索して特定し、最小の入力へ縮小する
- 原因を切り分ける。実装のずれなら実装を直し、テストの前提 (許容の式・生成範囲・warm-up の扱い) が誤りなら前提を直す。許容値を緩めることで隠さない
- 特定した入力を再現するテストを追加し、回帰を防ぐ
- 同じ 120 秒の到着列を使う他の assert (skewMs) も同時に確認する

## 完了条件

- 特定した入力で修正前に失敗し、修正後に通ることをテストで固定すること
- `vp test run src/playbackTimeline.prop.ts` を複数回実行して再発しないこと
- `vp check` / `tsc --noEmit` / `vp test run` が通ること

## 解決方法

{未着手}
