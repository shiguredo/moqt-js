# Publisher の pause / resume で処理ループが多重化する

- Created: 2026-09-06
- Completed: 2026-09-07
- Branch: feature/fix-publisher-pause-resume
- Polished: 2026-09-06

## 目的

`resume` のたびに常駐ループが増え、`onError` が多重発火しうる。世代管理で多重起動を防ぐ必要がある。

## 現状

- `src/createMediaPublisher.ts` の `pause` はフラグを下ろすだけで、`read()` 待機中の旧ループは終了しない。
- `resume` は無条件で `startProcessingLoops` を呼ぶため、新旧ループが同一 reader に並行 `read()` する。

## 設計方針

1. `pause` 時に `cancelFrameReaders` (stop / close と同形) で `read()` 待機を解除し、世代カウンタを加算する。
2. 処理ループは `read()` 解決直後に世代を再確認し、不一致なら `encode` せず終了する。新ループは現世代で起動するため、旧ループの終了待ちは不要である。
3. `resume` は現世代のまま `startProcessingLoops` する (`paused` からのみ到達し、旧ループは世代不一致で終了するため多重起動しない)。
4. 世代判定は単体テスト可能な形にし、世代不一致時の終了を単体テストで検証する。

## 完了条件

- 世代不一致の旧ループが `encode` せず終了すること (単体テスト)。
- 繰り返し pause / resume しても `onError` が多重発火しないこと。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 解決方法

- pause / stop / close で世代を進め、処理ループは read() 解決直後に世代を再確認し、不一致なら encode せず終了する。失敗通知も現世代のみに抑止する
- 設計方針の pause 時 cancel は見送った。cancel はストリームを閉じるため resume 時に再開できなくなる。世代ガードのみで多重化と多重発火は起きない
- 世代テスト 8 件を追加した。旧コードで落ちることを確認した
- `CHANGES.md` の `## develop` に `[FIX]` を追記した
