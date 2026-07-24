# 未知 Catalog field を Variable Substitution 対象にする

- Priority: Low
- Created: 2026-07-24
- Completed: YYYY-MM-DD
- Model: Composer
- Branch: feature/change-msf-variable-substitution-unknown-fields
- Polished: YYYY-MM-DD

## 目的

draft-ietf-moq-msf-01 §5.4 Variable Substitution と §5.6.14 では、Track Object 内の未知 field (例: `c4m`) も置換対象になり得る。現状の `resolveCatalogVariables` は既知 field のみを対象にし、未知 field は ignore したまま置換しない (`#0316` 範囲外)。

## 優先度根拠

既知 field の `%name%` 置換は動作する。未知 field 対応は拡張 catalog / ベンダー固有 field 向けで、標準メディア再生の必須ではないため Low。

## 現状

- `resolveCatalogVariables` (`src/msf.ts:2059` 付近) は既知キーの文字列を走査
- 未知 field は `validateCatalog` で ignore (§5 parser MUST ignore unknown)
- `#0316` 範囲外: 「未知 catalog field (例: §5.6.14 の `c4m`) を Variable Substitution の対象に含める」

## 設計方針

1. Track Object / root の未知 string field にも `%var%` 置換を適用する
2. オブジェクト / 配列への再帰規則を仕様 §5.4 に合わせて定義しテストで固定する
3. 変数名 / 値の文字種制約は既存と同じ

## 完了条件

- 未知 string field 内の `%var%` が置換される
- §5.6.14 相当の fixture (または同等の未知 field) でテストがある
- `vp run test` / `vp run build` が pass する

## 関連

- `#0316` (closed)
- `#0345` Catalog delta / Joining FETCH（本項目は draft-01 残から分離）
- `#0356` URI fragment reserved key helper
