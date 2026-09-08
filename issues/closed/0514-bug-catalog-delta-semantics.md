# Catalog delta の適用意味を正す

- Created: 2026-09-06
- Completed: 2026-09-08
- Branch: feature/fix-catalog-delta-semantics
- Polished: 2026-09-06

## 目的

delta の未知ルートフィールドが decode で捨てられ round-trip (decode → encode) せず、存在しない `remove` が無操作成功になる。full 側および clone / add の不存在・重複系 throw と方針を統一する必要がある。

## 現状

- `src/msf.ts` の `decodeCatalogDelta` は `generatedAt` 以外の未知ルートフィールドを捨てる (decode 問題。full 側は保持する)。
- `remove` 対象の不存在が無操作成功となり、typo を検出できない (apply 問題。`add` 重複は最終検査で throw、`clone` 親不存在は throw する非対称。`clone` 自体は統一済みのため対象外)。

## 設計方針

1. 未知ルートフィールドは full 側と同一の保持に統一する (§5 保持解釈。`CatalogDelta` 型の拡張を含む)。
2. `remove` 不存在は `throw` する (plain `Error`。`clone` 親不存在・`add` 重複と同一契約。警告案は捨てる)。
3. 未知 root 保持の round-trip テストと `remove` 不存在 throw テストを `src/msf.test.ts` に追加する。

## 完了条件

- 未知ルートフィールドが decode → encode で round-trip すること。
- 不存在 `remove` が throw すること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 解決方法

- `src/msf.ts` の `decodeCatalogDelta` と `encodeCatalogDelta` で未知ルートフィールドを full 側と同様に保持する。内部表現との衝突回避に既知集合を新設した
- `applyCatalogDelta` の存在しない `remove` を `throw` する (add 重複・clone 親不存在と同一契約)
- `src/msf.test.ts` に round-trip と不存在・境界のテスト 6 件を追加した
- `CHANGES.md` の `## develop` に `[FIX]` を追記した

## 関連

- draft-ietf-moq-msf-01 §5 / §5.3
