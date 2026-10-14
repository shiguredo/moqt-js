# delta 経路では変数を含む initRef の参照切れが検出されない

- Created: 2026-10-14
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-catalog-delta-variable-init-ref

## 目的

`applyCatalogDelta` (§5.1.6 / §5.3) は合成後の Catalog に対して `assertInitRefResolvable` を呼ぶが、この検証は `%` を含む値を対象外にする (置換前は参照先を判定できないため)。delta の add / clone が変数を含む `initRef` を持ち込んだ場合、合成後も未解決のまま残り、参照切れが検出されない。0692 は `resolveCatalogVariables` に置換後の検証を入れたが、delta 経路は置換を行わないため、購読側が delta を適用しただけでは同じ穴が残る。

## 現状

- `src/msf/catalogDelta.ts` の `applyCatalogDelta` は合成後に `assertInitRefResolvable` を呼ぶ。同関数は `initDataList` の id に `%` が含まれる場合に検証全体を打ち切り、track の `initRef` に `%` が含まれる場合も個別に skip する
- `applyCatalogDelta` は変数を受け取らず、置換も行わない。delta の `add` / `clone` が `initRef: "%init%"` を持ち込むと、合成後の Catalog にもそのまま残る
- 実測: `%init%` を含む initRef の add は delta 適用後に素通りし、`resolveInitData` が `undefined` を返す。`encodeCatalog` に渡すと参照切れの検証 (0647) ではなく変数のままの値が載る
- `src/msf/variables.ts` の `resolveCatalogVariables` を delta 適用後に呼べば検出できる (0692) が、その呼び出しは購読経路に無い (issues/0853-bug-subscriber-variable-substitution.md)

## 設計方針

- delta の合成結果に変数を含む `initRef` が残った場合の扱いを決める。候補は (a) `applyCatalogDelta` が「変数を含む initRef が残っている」ことを検出して throw する、(b) delta の add / clone が変数を含む `initRef` を持つことを許容し、置換は呼び出し元の責務であると JSDoc に明記したうえで、置換後の検証を 0692 の経路に委ねる
- §5.4.2 の変数は URI fragment 由来であり、delta の受信時に fragment の値を持っているとは限らない。そのため (b) を第一候補とし、(a) は「解決できないまま後段へ流れるより早期に拒否する」方針を採る場合に限る
- いずれの場合も `applyCatalogDelta` の JSDoc に、変数を含む `initRef` は検証されないことを明記する
- 対象は `src/msf/catalogDelta.ts` / `src/msf/variables.ts` / `src/msf.test.ts`。選択した方針によって完了条件が変わるため、実装前に方針を確定する

## 完了条件

- delta の add / clone が変数を含む `initRef` を持ち込んだときの挙動 (拒否する / 置換を呼び出し元の責務として明記する) が決まり、テストで固定される
- 置換を行った場合、参照切れは `resolveCatalogVariables` が throw する (0692 の検証)
- 変数を含まない delta の検証結果は変わらない
- `npx vp check` / `npx tsc --noEmit` / `npx vp test --run` が通る

## 参照

- draft-ietf-moq-msf-01 §5.1.6 (delta update の op) / §5.3 (wire 形式) / §5.4 (Variable Substitution) / §5.4.2 (fragment 由来) / §5.2.13 (initRef) / §5.1.7 (initDataList)
- `src/msf/catalogDelta.ts` の `applyCatalogDelta`
- `src/msf/catalogValidation.ts` の `assertInitRefResolvable` (`%` を含む値を対象外にする条件)
- `src/msf/variables.ts` の `resolveCatalogVariables` (0692 で置換後の参照切れ検証を追加)
- closed `0692-bug-catalog-init-ref-substitution-revalidation.md` (「残した課題」に本件がある)

## 解決方法

{未着手}
