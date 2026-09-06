# devtools Subscriber の catalog 購読が unsubscribe されずに捨てられる

- Created: 2026-09-06
- Completed: YYYY-MM-DD
- Branch: feature/fix-devtools-catalog-unsubscribe
- Polished: 2026-09-06

## 目的

停止時に catalog 購読の graceful な解除が送られず、`session.close` 任せの破棄になる。停止経路で `unsubscribe` する必要がある。

## 現状

- 定常停止・破棄経路 (`stopSubscribing` 本体、`teardownSubscriber` 経由 6 箇所、`removeSubscriber`) は catalog 側の `unsubscribe` を呼ばない。`stopSubscribing` は本体のみ解除し、`teardownSubscriber` は signal を null 化するだけである。例外的に `signal.aborted` 時の競合ガードのみ catalog を解除する。

## 設計方針

1. catalog 解除を `closeSubscriberResources` に寄せる (`teardownSubscriber` 経由全 6 箇所と `stopSubscribing` の finally が対象になる)。`removeSubscriber` は同関数を経由しないため並行して追加する。`unsubscribe` は fire-and-forget し失敗を握り潰す (既存の `session.close` と同形)。
2. 二重解除は解除前の null チェックと解除後の null 化で抑止し、逐次二重は `unsubscribe` 自体の冪等 (`closed` 早期 return) に委ねる。

## 完了条件

- 停止時に catalog 購読へ `unsubscribe` が送出されること (`stopSubscribing` / `teardown` / `removeSubscriber` の各経路)。
- 二重停止でも例外なく終わること (自動テストは `0513` に委ねる)。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 関連

- `0513` (devtools 側の停止経路テストの方針)
