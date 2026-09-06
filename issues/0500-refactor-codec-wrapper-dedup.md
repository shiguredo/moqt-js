# codec ラッパーと Worker の重複を除去する

- Created: 2026-09-06
- Completed: YYYY-MM-DD
- Branch: feature/refactor-codec-wrapper-dedup
- Polished: YYYY-MM-DD

## 目的

同型ロジックが 8 箇所に分散し、1 件の修正が複数箇所保守になる。共通化する必要がある。

## 現状

- 4 ラッパー (`src/codec/` の両 Encoder / 両 Decoder) の `configureWorker` / `configureDirect` / `state` / `close` が骨格同一である。
- 4 Worker の `init` / `encode` / `decode` / `close` 分岐が重複する。
- 再 `configure` で旧 Worker を破棄しない (Decoder の `reset` は破棄する非対称)。
- 未設定時の `console.warn` 6 件が `callbacks.error` と二重化する。
- `default` フォールバックが型網羅を隠す。

## 設計方針

1. 共通ベースまたはヘルパーに寄せる (ラッパー側と Worker 側)。
2. 再 `configure` 時の破棄、`console.warn` の一本化、網羅 `switch` 化を合わせる。

## 完了条件

- 重複が除去され、既存テストと挙動が保たれること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。
