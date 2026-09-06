# タイマーの解放漏れ

- Created: 2026-09-06
- Completed: YYYY-MM-DD
- Branch: feature/fix-timer-cleanup
- Polished: YYYY-MM-DD

## 目的

早期解決・早期成功時にタイマーが残存し、高頻度 FETCH / `done()` で蓄積する。不要になったタイマーは解放する必要がある。

## 現状

- `src/session/incoming.ts` の `incomingWaitForFetcher` の 5 秒フォールバックが早期解決時に `clearTimeout` されない。
- `src/session/publish.ts` の `publishClosePublisherStreamInternal` の `writer.close` タイムアウトが早期成功時に解放されない。
- 多重解決はフラグで防ぐがタイマー自体は残る。

## 設計方針

1. 両箇所で確定時に `clearTimeout` する。
2. タイマー累積の回帰テストを追加する (フェイクタイマー等)。

## 完了条件

- 早期確定時にタイマーが残存しないこと。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。
