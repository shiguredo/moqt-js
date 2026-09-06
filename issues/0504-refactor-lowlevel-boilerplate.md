# 低レベル送受信の定型処理重複を除去する

- Created: 2026-09-06
- Completed: YYYY-MM-DD
- Branch: feature/refactor-lowlevel-boilerplate
- Polished: YYYY-MM-DD

## 目的

ガードと配送処理の同型コードが分散し、フィルタ引数変更時に複数箇所修正が必要になる。共通化する必要がある。

## 現状

- `src/subscriber.ts` の `handleObject` / `handleDatagram` がフィルタ再適用まで約 20 行同一である。
- `src/publisher.ts` の `sendObject` / `sendDatagram`、`src/fetcher.ts` のガードが同型である。

## 設計方針

1. フィルタ照合とガードを共通ヘルパーに抽出する。
2. 送信ガードの振る舞い変更 (`0490`) との順序を調整する。

## 完了条件

- 重複が除去され、既存テストが全て通ること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 関連

- `0490` (送信ガードの振る舞い変更)
