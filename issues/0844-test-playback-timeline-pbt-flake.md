# playbackTimeline の PBT が浮動小数点の誤差でまれに失敗する

- Created: 2026-10-12
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-playback-timeline-pbt-flake
- Polished: {YYYY-MM-DD}

## 目的

`src/playbackTimeline.prop.ts` の「PlaybackTimeline: 120 秒の到着列でも同時刻の表示時刻の差は合わせない分に収まる」が、まれに `AssertionError: expected 100.00000000000001 to be at most 100` で失敗する。`timeline.delayBreakdown` の `audio.syncExtraDelayMs` が上限 `PLAYOUT_MAX_COMPENSATED_DIFFERENCE_MS` (100 ms) を浮動小数点の誤差 (約 1e-14 ms) で超えるためである。テストが不安定だと CI が無関係に落ち、実装の回帰と区別できない。

## 現状

- 実測: 全件実行 (`npx vp test --run`) で 1 回失敗を観測した。`npx vp test --run src/playbackTimeline.prop.ts` を 5 回実行した範囲では再現しない (生成される到着列に依存する)
- 120 秒の到着列のテストは、同じファイル内で 2 通りの比較をしている
  - `maxDifferenceMs` は `allowedDifferenceMs + ALLOWANCE_MS` (0.1 ms) と比較しており、丸めの分を許している
  - `breakdown.audio.syncExtraDelayMs` は上限 `PLAYOUT_MAX_COMPENSATED_DIFFERENCE_MS` そのものと比較しており、丸めの分を許していない
- 同期の制御が足す量は、`syncExtraDelayMs` を求める過程で µs への丸めと分布の窓を経由する

## 設計方針

- 実装が上限を超えたままにならないことを保つ。比較にだけ丸めの許容幅を持たせる (上限そのものを緩めない)
- 許容幅は既存の `ALLOWANCE_MS` / `TOLERANCE_MS` と同じ考え方で決め、根拠をコメントに書く
- 現在の `maxDifferenceMs` の比較と同じ幅で足りるかを確かめ、足りない場合だけ広げる
- 再現する seed が見つかった場合は、その到着列を固定した例を 1 つテストへ残す (見つからなければ残さない)
- 対象外: `PlaybackTimeline` 本体の同期の制御 (実装の変更が要る場合は別 issue にする)

## 完了条件

- 同じ property を 1000 seed 以上で実行して失敗しない
- 比較の許容幅と根拠がコメントに書かれている
- `npx vp check` / `npx vp test --run` が通る

## 参照

- `src/playbackTimeline.prop.ts` の `runArrivals` と「120 秒の到着列でも同時刻の表示時刻の差は合わせない分に収まる」
- `src/playbackTimeline.ts` の `PLAYOUT_MAX_COMPENSATED_DIFFERENCE_MS` / `SYNC_MIN_DELTA_MS` / `delayBreakdown`

## 解決方法

{未着手}
