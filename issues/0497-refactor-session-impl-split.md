# SessionImpl の肥大化を分割する

- Created: 2026-09-06
- Completed: YYYY-MM-DD
- Branch: feature/refactor-session-impl-split
- Polished: YYYY-MM-DD

## 目的

`SessionImpl` (約 4800 行) が制御・データ・統計・ストリーム管理の全てを保持し、変更耐性と可読性を下げている。責務ごとに分割する必要がある。

## 現状

- `src/session.ts` 本体に接続・購読・発行・fetch・namespace 系・統計が同居する。
- `src/session/` 配下への分割は進んでいるが本体が残存する。

## 設計方針

1. 接続・購読・発行・namespace 系・統計の単位で段階的に抽出する (一括分割ではなく issue 内で複数コミットに分ける)。
2. 公開 API の互換性を維持する (`CODEBASE.md` の破壊的変更許容と相談のうえ)。

## 完了条件

- 本体の行数が段階的に削減され、責務単位で見通せること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。
