# msf fragment の解析が literal で書ける byte の hex 表現を受理する

- Created: 2026-10-07
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-msf-literal-hex-encoding
- Polished: 2026-10-07

## 目的

draft-ietf-moq-transport-22 §8.8 は、MSF fragment の namespace-name 文字列の解析について「a byte that could have been represented literally but was hex-encoded」を MUST reject と定めている (例: `a` は literal の `a` で書くため `.61` は invalid)。draft-ietf-moq-msf-01 §11.1.2 はこの convention を normatively 採用している。`parseMsfFragmentValue` はこの MUST を満たしておらず、literal で書ける byte の hex 表現を受理する。公開 API として §11.1.2 の解析器を名乗る以上、MUST を満たす必要がある。

## 現状

- `src/msf/fragment.ts` の `decodeMsfSegment` は `.HH` の byte をそのまま復号するため、次の入力が受理される (実測)
  - `parseMsfFragmentValue("n.61--t")` → trackNamespace `["na"]`
  - `parseMsfFragmentValue("n.5f--t")` → trackNamespace `["n_"]`
  - `parseMsfFragmentValue("n.41--t")` → trackNamespace `["nA"]`
- MSF §11.1.2 の escape 規則は「Unreserved characters (a-z, A-Z, 0-9, _) are represented literally」「All other byte values MUST be percent-encoded」であり、literal で書ける byte の hex 表現は規則違反になる
- `src/fullTrackName.ts` の `escapeFullTrackNameSegment` は literal で書ける byte を hex にしないため、この修正で往復の round-trip テストは壊れない
- 復号される byte 列は変わらないため、利用者に見える誤りは無い

## 設計方針

- `decodeMsfSegment` で、`.HH` の byte が literal で書ける文字 (`[0-9A-Za-z_]`) のときは `Error` を投げる。エラーメッセージは §8.8 / §11.1.2 を根拠として示し、実際の byte と literal 表記を含める
- 対象は MSF fragment の解析のみとする。`src/fullTrackName.ts` の formatter は既に literal で書ける byte を hex にしないため変更しない
- エラーメッセージをテストで固定する。既存の percent-encoding の round-trip (`src/msf.prop.ts`) は literal 側で生成されるため影響しないことを確認する
- 後方互換のない挙動変更 (受理していた入力が拒否される) のため `CHANGES.md` の `## develop` に `[FIX]` として記載する

## 完了条件

- `parseMsfFragmentValue("n.61--t")` / `"n.5f--t"` / `"n.41--t"` が `Error` を投げる
- literal で書ける byte を literal で書いた入力 (`na--t` など) は従来どおり受理される
- `.2d` (literal で書けない byte) のような percent-encoding は従来どおり受理される
- `src/msf.prop.ts` の round-trip と `src/fullTrackName.prop.ts` の round-trip が通る
- `vp check` / `vp test run` / `vp run build:devtools` が通る
- `CHANGES.md` の `## develop` に `[FIX]` として記載されている

## 参照

- `refs/moq/draft-ietf-moq-transport-22.txt` の §8.8 (MUST reject の文面と `.61` の例)
- `refs/moq/draft-ietf-moq-msf-01.txt` の §11.1.2 (Unreserved characters / All other byte values MUST be percent-encoded)
- `src/msf/fragment.ts` の `decodeMsfSegment` / `src/fullTrackName.ts` の `escapeFullTrackNameSegment`

## 解決方法

{未着手}
