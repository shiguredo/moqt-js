# コメント・メッセージの規約適合を修正する

- Created: 2026-09-06
- Completed: YYYY-MM-DD
- Branch: feature/fix-comment-conventions
- Polished: YYYY-MM-DD

## 目的

issue 番号の持ち込み・旧文書言及・英語のみコメント・引用節のずれが残り、規約に反する。適合させる必要がある。

## 現状

- `src/msf.ts` の `(#0316)` 2 件、`CHANGES.md` の `(#....)` 145 件、devtools の `(#0149)` 等が残る。
- `src/msf.ts` の旧文書言及 (`CLAUDE.md` 参照) が残る。
- transport core・devtools に英語のみコメント、devtools に大文字始まりメッセージが残る。
- `src/msf.ts` の `createCompleteCatalog` の節引用 (§9.2 は Log track namespace and name) が `isComplete` の根拠としてずれている (moqmetrics の truncate 引用 §10.3 と granularity 引用 §10.2 は正しいため対象外)。

## 設計方針

1. issue 番号は理由そのものの記述に置き換え、旧文書言及を現行規約に直す。
2. 英語のみコメントを日本語化し、引用節を正す。
3. `CHANGES.md` の `(#....)` は新規エントリに書かない。既存 145 件は理由そのものへの置き換えを段階的に対応する (履歴自体は残す)。

## 完了条件

- 上記の規約違反が解消されること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。
