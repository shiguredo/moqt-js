# bidi 応答読み取りと namespace ループの重複を除去する

- Created: 2026-09-06
- Completed: YYYY-MM-DD
- Branch: feature/refactor-bidi-namespace-dedup
- Polished: YYYY-MM-DD

## 目的

同型ロジックが 4 箇所・2 箇所に複製され、1 件の修正が複数箇所保守になる。共通化して 1 箇所保守にする必要がある。

## 現状

- `src/session/bidi.ts` の 4 種の応答読み取り (PUBLISH / SUBSCRIBE / FETCH / TRACK_STATUS) が定型処理を複製する (共通ヘルパー `bidiReadResponseFromBidiStream` は共有済み。残差分は OK 系 decode と scope 検証のみ)。
- `src/session/namespaceLoops.ts` の 3 ループ (Namespace / Tracks / Publication) が done 処理・状態管理・3 分岐を複製する。

## 設計方針

1. 応答読み取りを共通リーダ + 分岐テーブルに畳む。
2. namespace ループを共通ループ + メッセージハンドラ注入に畳む。

## 完了条件

- 重複が除去され、既存テストが全て通ること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。
