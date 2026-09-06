# Catalog delta の適用意味を正す

- Created: 2026-09-06
- Completed: YYYY-MM-DD
- Branch: feature/fix-catalog-delta-semantics
- Polished: YYYY-MM-DD

## 目的

delta 経由の未知フィールドが round-trip せず、存在しない `remove` が無操作成功になる。検証方針を統一する必要がある。

## 現状

- `src/msf.ts` の `decodeCatalogDelta` は `generatedAt` 以外の未知ルートフィールドを捨てる (full 側の保持方針と不統一)。
- `remove` 対象の不存在が無操作成功となり、typo を検出できない (`add` の重複は検出する非対称)。

## 設計方針

1. 未知フィールドの保持方針を full / delta で統一する (§5 の ignore 規定と整合させる)。
2. `remove` 不存在の扱い (警告または失敗) を決める。

## 完了条件

- 方針が統一されテストで pin されること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 関連

- draft-ietf-moq-msf-01 §5 / §5.3
