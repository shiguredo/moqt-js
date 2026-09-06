# datagram 経路のアプリ例外が黙殺される

- Created: 2026-09-06
- Completed: YYYY-MM-DD
- Branch: feature/fix-datagram-error-propagation
- Polished: 2026-09-06

## 目的

datagram 配送中のアプリ例外が debug 記録のみで握り潰され、配送失敗として観測できない。当該購読の `error` コールバックへ届ける必要がある。

## 現状

- `src/session/incoming.ts` の `incomingHandleDatagram` は decode から `handleDatagram` / `handleObject` (アプリコールバックを同期呼び出し) まで全体を `try` で包み、アプリ例外も debug 記録のみで握り潰す (close も `error` 通知もなし)。
- 対照的に subgroup 経路は `processSubgroupObjects` 境界で再送出し、呼び出し元の内側 `catch` で `INTERNAL_ERROR` としてセッションを閉じる。購読の `error` コールバックにはどちらの経路も届かない。

## 設計方針

1. datagram 配送は subscriber ごとに `try` / `catch` し、アプリ例外時は当該 subscriber の `handleError` (`SubscribeCallbacks.error`) へ通知して残りの配送を継続する。subgroup とは異なりセッションは閉じない。
2. デコード失敗の扱いは変えない (`ProtocolViolation` / `Incomplete` のみ close、他は debug 記録)。

## 完了条件

- datagram 配送中のアプリ例外が当該購読の `error` コールバックに届き、他の購読への配送が継続されること。セッションは閉じないこと。
- デコード失敗時は従来どおり `error` コールバックに届かないこと (区別の検証)。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。
