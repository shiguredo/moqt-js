# peerMaxFilterRanges 宣言の重複一本化と見出し統合

- Created: 2026-09-07
- Completed: YYYY-MM-DD
- Branch: feature/refactor-peer-max-filter-ranges
- Polished: YYYY-MM-DD

## 目的

同一フィールドが基底と派生の両方で重複宣言され、見出しも分裂している。宣言を一本化して乖離の余地をなくす必要がある。

## 現状

- `peerMaxFilterRanges` が `BidiSessionInternal`（`src/session/bidi.ts`）と `SessionInternal`（`src/session/types.ts`）の両方で宣言され、`readonly` の有無のみが異なる重複になっている。
- `SessionInternal` 内に `publish.ts 用` と `publish.ts 用（追加分）` の 2 見出しが併存している。

## 設計方針

1. 宣言を継承元に一本化し、見出しを `publish.ts 用` に集約する。派生側の再宣言を削除する。

## 完了条件

- 重複宣言と見出し分裂が解消されること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 関連

- `src/session/bidi.ts` の `BidiSessionInternal`
- `src/session/types.ts` の `SessionInternal`
