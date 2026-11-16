# delta 適用後の再検証と isLive 遷移の検出を実装する

- Created: 2026-11-16
- Completed: {YYYY-MM-DD}
- Branch: feature/update-msf-draft-02
- Polished: {YYYY-MM-DD}

## 目的

draft-02 対応の監査で、delta の clone / update を適用した後の catalog が不正になり得ることが分かった。あわせて、§5.2.8 が MUST NOT とする `isLive` の false → true 遷移を検出していない。

## 現状

- `src/msf/catalogDelta.ts` の `revalidateMergedTrack` は packaging 別 MUST・role 条件付き MUST・audio の codec MUST を再実行するが、Table 5 の packaging 値集合と Table 6 (`validateRequiredFieldsPerPackagingAndRole`) を再実行しない。実測では `update` で `packaging: "bogus"`、`clone` で `role: "video"` かつ framerate 欠落が `applyCatalogDelta` を通過し、その結果を `encodeCatalog` が拒否した
- `src/msf/catalogValidation.ts` の `validateUpdateCatalogTrack` / `validateCloneCatalogTrack` は packaging を typeof だけで検証する
- `applyCatalogDelta` は base の track と合成後の track の `isLive` を比較しない。§5.2.8 は "A True value MUST never follow a False value" と定める
- `update` operation の単体テストが無く、add 既存名 / clone 既存名 / update 未知 track の拒否テストも無い

## 設計方針

- `revalidateMergedTrack` で `MSF_PACKAGING_VALUES` の membership と `validateRequiredFieldsPerPackagingAndRole` を呼ぶ。delta の適用結果が単体の track として妥当であることを、decode 経路と同じ関数で保証する
- `applyCatalogDelta` で、変更対象の track について base の `isLive` が false で合成後が true なら拒否する。新規 add の track は比較対象が無いため検査しない
- add 既存名・clone 既存名・update 未知 track・update の宣言フィールド上書きを単体テストで固定する

## 完了条件

- `update` で `packaging: "bogus"` を適用できない。単体テストで固定する
- `clone` / `update` で Table 6 違反の track を作れない。単体テストで固定する
- `isLive: false` の track への true 遷移を拒否する。単体テストで固定する
- `update` の宣言フィールド上書きと `name` 改名、add 既存名 / clone 既存名 / update 未知 track の拒否を単体テストで固定する
- `npx vp check` / `npx tsc --noEmit` / `npx vp test --run` が通る
