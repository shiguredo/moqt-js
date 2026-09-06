# datagram 経路のアプリ例外が黙殺される

- Created: 2026-09-06
- Completed: YYYY-MM-DD
- Branch: feature/fix-datagram-error-propagation
- Polished: YYYY-MM-DD

## 目的

datagram 配送中のアプリ例外が debug 記録のみで握り潰され、配送失敗として観測できない。`error` コールバックへ届ける必要がある。

## 現状

- `src/session/incoming.ts` の `incomingHandleDatagram` は decode から `handleDatagram` / `handleObject` (アプリコールバックを同期呼び出し) まで全体を `try` で包み、`ProtocolViolation` / `Incomplete` 以外を記録のみで握り潰す。
- `src/session/stream.ts` の subgroup 経路はアプリ例外を透過させるため、経路により振る舞いが変わる。

## 設計方針

1. アプリ由来の例外を `error` コールバックへ通知する (subgroup 経路と同一方針)。
2. デコード失敗とアプリ例外の区別を保つ。

## 完了条件

- datagram 配送中のアプリ例外が `error` コールバックに届くこと。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。
