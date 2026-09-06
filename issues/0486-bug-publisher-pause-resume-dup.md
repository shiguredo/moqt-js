# Publisher の pause / resume で処理ループが多重化する

- Created: 2026-09-06
- Completed: YYYY-MM-DD
- Branch: feature/fix-publisher-pause-resume
- Polished: YYYY-MM-DD

## 目的

`resume` のたびに常駐ループが増え、`onError` が多重発火しうる。世代管理で多重起動を防ぐ必要がある。

## 現状

- `src/createMediaPublisher.ts` の `pause` はフラグを下ろすだけで、`read()` 待機中の旧ループは終了しない。
- `resume` は無条件で `startProcessingLoops` を呼ぶため、新旧ループが同一 reader に並行 `read()` する。

## 設計方針

1. ループ世代ガード (generation counter 等) を導入し、旧世代ループを終了させる。
2. `resume` 時の旧ループ終了待ちまたは多重起動防止を入れる。

## 完了条件

- 繰り返し pause / resume してもループが 1 系統であること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。
