# devtools Subscriber の catalog 購読が unsubscribe されずに捨てられる

- Created: 2026-09-06
- Completed: YYYY-MM-DD
- Branch: feature/fix-devtools-catalog-unsubscribe
- Polished: YYYY-MM-DD

## 目的

停止時に catalog 購読の graceful な解除が送られず、`session.close` 任せの破棄になる。停止経路で `unsubscribe` する必要がある。

## 現状

- `devtools/src/hooks/useSubscriber.ts` の停止・破棄 4 経路はいずれも catalog 側の `unsubscribe` を呼ばない (本体のみ呼ぶ箇所あり)。

## 設計方針

1. 全停止経路で catalog 購読の `unsubscribe` を行う (既存のリソース集約に寄せる)。
2. 二重解除の安全を確保する。

## 完了条件

- 停止時に catalog 購読が graceful に解除されること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。
