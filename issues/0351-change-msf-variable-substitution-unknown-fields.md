# 未知 Catalog field を Variable Substitution 対象にする

- Priority: Low
- Created: 2026-07-24
- Completed: YYYY-MM-DD
- Model: Composer
- Branch: feature/change-msf-variable-substitution-unknown-fields
- Polished: 2026-07-27

## 目的

draft-ietf-moq-msf-01 §5.4 Variable Substitution と §5.6.14 (非規範例) では、Track Object 内の未知 field (例: `c4m`) も置換対象になり得る。現状の `resolveCatalogVariables` は既知 field のみを対象にし、未知 field は置換しない (`#0316` 範囲外)。

注: §5.4 は "Catalog field values MAY contain variables" (refs L1586) の MAY であり、未知 field 置換の MUST / SHOULD は存在しない。§5.6 は非規範例 ("non-normative JSON examples", refs L1648)。本 issue は MAY の実装であり、仕様上の必須度は低い。

## 優先度根拠

既知 field の `%name%` 置換は動作する。未知 field 対応は拡張 catalog / ベンダー固有 field 向けで、標準メディア再生の必須ではないため Low。

## 現状

- `resolveCatalogVariables` (`src/msf.ts:2059` 付近) は既知キーの文字列を走査 (`substituteTrack` の `stringFields` 固定ホワイトリスト、`src/msf.ts:2120-2137`)
- **未知 field は `validateCatalog` / `buildValidatedCatalogTrack` で構造的に破棄されている**: root は `const catalog: Catalog = { version, tracks }` (`src/msf.ts:860`) で既知 field のみ新規構築、track は `pick*` 群で既知 field のみ pick (`src/msf.ts:1175` 付近)。§5 の "parser MUST ignore unknown" を「破棄」と解釈して実装している
- このため `resolveCatalogVariables` に届く時点で未知 field はオブジェクト上に存在しない。`resolveCatalogVariables` だけ修正しても実 decode 経路では未知 field が置換されない
- `#0316` 範囲外: 「未知 catalog field (例: §5.6.14 の `c4m`) を Variable Substitution の対象に含める」
- 注: §5.4 にはネストした object / array への再帰規則は存在しない。現状コードも `accessibility` / `authInfo` / `depends` をハードコード処理しているだけ
- 注: §11.1.1 の `c4m` は base64 文字列だが、§5.4.1 の変数値文字集合 `[A-Za-z0-9_@-]` (refs L1603-1608) は base64 の `+` / `/` / `=` を含まない。実 c4m token は変数値として運べない可能性がある

## 設計方針

1. **前提として `validateCatalog` / `buildValidatedCatalogTrack` が未知 field を構造的に保持するよう改修する**。§5 の "MUST ignore unknown" の解釈を「破棄」から「検証はしないが保持」に変更する。これにより `resolveCatalogVariables` に未知 field が届くようになる
2. Track Object / root の未知 string field にも `%var%` 置換を適用する。再帰規則は仕様 §5.4 に定義がないため、本 issue で方針を定義しテストで固定する（ネスト object / array 内の文字列も走査する）
3. 変数名 / 値の文字種制約は既存と同じ
4. `resolveCatalogVariables` の doc コメント（「未知フィールドは validateCatalog で ignore 済みのため対象外」）を更新する

## 完了条件

- `decodeCatalogMessage` → `validateCatalog` → `resolveCatalogVariables` の **end-to-end 経路** で未知 string field 内の `%var%` が置換される（手組み Catalog の単体テストだけでなく、decode 経路を含むテストがある）
- §5.6.14 相当の fixture (または同等の未知 field) でテストがある
- `CHANGES.md` の `## develop` に `[CHANGE]` を追記する（validateCatalog の未知 field 保持化は既存挙動の変更）
- `vp run test` / `vp run build` が pass する

## 関連

- `#0316` (closed)
- `#0345` (closed) Catalog delta / Joining FETCH（本項目は draft-01 残から分離。依存関係ではない）
- `#0356` URI fragment reserved key helper
