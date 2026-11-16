# delta 経路では変数を含む initRef の参照切れが検出されない

- Created: 2026-10-14
- Completed: 2026-11-16
- Branch: feature/fix-catalog-delta-variable-init-ref
- Polished: 2026-11-15

## 目的

`applyCatalogDelta` (§5.1.6 / §5.3) は合成後の Catalog に対して `assertInitRefResolvable` を呼ぶが、この検証は `%` を含む値を対象外にする (置換前は参照先を判定できないため)。delta の add / clone が変数を含む `initRef` を持ち込んだ場合、合成後も未解決のまま残り、参照切れが検出されない。0692 は `resolveCatalogVariables` に置換後の検証を入れたが、delta 経路は置換を行わないため、購読側が delta を適用しただけでは同じ穴が残る。

本 issue は `applyCatalogDelta` の契約を「変数は解決しない。置換は呼び出し元の責務であり、置換後の参照切れ検証は `resolveCatalogVariables` が行う」と確定し、JSDoc とテストで固定する。

## 現状

- `src/msf/catalogDelta.ts` の `applyCatalogDelta` は合成後に `assertInitRefResolvable` を呼ぶ。同関数は `initDataList` の id に `%` が含まれる場合に検証全体を打ち切り、track の `initRef` に `%` が含まれる場合も個別に skip する
- `applyCatalogDelta` は variables を受け取らず、置換も行わない。delta の `add` / `clone` が `initRef: "%init%"` を持ち込むと、合成後の Catalog にもそのまま残る
- 実測: `%init%` を含む `initRef` の add は delta 適用後に素通りし、`resolveInitData` が `undefined` を返す。`encodeCatalog` に渡すと `%init%` のまま wire に載り、`assertInitRefResolvable` の `%` 対象外条件により参照切れとして拒否されない
- `src/msf/variables.ts` の `resolveCatalogVariables` は 0692 で置換後の `initRef` 参照切れを検証する。delta 適用後の Catalog に呼べば参照切れを検出できるが、本 issue の時点ではプロダクションコードからの呼び出しは無い (issues/0853-bug-subscriber-variable-substitution.md が購読経路への組み込みを扱う)
- `applyCatalogDelta` は `src/index.ts` で公開されている。`resolveCatalogVariables` は `src/msf.ts` からのみ export され、公開パッケージの API には含まれない

## 設計方針

- delta の合成結果に変数を含む `initRef` が残った場合の扱いを (b) に確定する。`applyCatalogDelta` は変数を解決せず、delta の add / clone が変数を含む `initRef` を持つことを許容し、合成結果にそのまま残す。置換は呼び出し元の責務とし、置換後の参照切れ検証は 0692 で `resolveCatalogVariables` に入れた `assertInitRefResolvable` に委ねる
- (a)「`applyCatalogDelta` が変数を含む `initRef` が残っていることを検出して throw する」は採らない。§5.4 は catalog field values に変数を含めることを許すため、delta の add / clone が変数を含む `initRef` を持つことは正当な入力である。`applyCatalogDelta` は variables を受け取らないため合成時点で変数を解決できず、`%` を見て一律に throw すると、置換を前提とする正当な delta を拒否してしまう。また `applyCatalogDelta` は `src/index.ts` で公開されており、受理集合を狭める挙動変更は公開 API の破壊的変更になる
- §5.4.2 の変数は catalog を取得した URI の fragment 由来であり、fragment の解決は delta の適用とは別の関心事である。本 issue は `applyCatalogDelta` の挙動を変えず、契約を JSDoc とテストで固定する
- `applyCatalogDelta` の JSDoc に次を明記する: 合成結果の `initRef` が `%` を含む場合、`assertInitRefResolvable` は参照先を判定できないため検証を skip する。変数を解決するのは呼び出し元の責務であり、delta 適用後の Catalog に対して `resolveCatalogVariables` を呼べば、置換後の参照切れを検出できる
- `src/msf/variables.ts` は 0692 で実装済みのため変更しない。delta 適用後の置換と検証の経路は `src/msf.test.ts` のテストで固定する
- `resolveCatalogVariables` の公開 API への追加は本 issue の対象外とする (0853 の方針に合わせ、必要なら別途判断する)
- 対象は `src/msf/catalogDelta.ts` (JSDoc) と `src/msf.test.ts` (テスト)。挙動を変えないため `CHANGES.md` は更新しない (CODEBASE.md の「MOQT RFC ドラフト中の特別ルール」とも整合)

## 完了条件

- `applyCatalogDelta` の JSDoc に、変数を含む `initRef` は `assertInitRefResolvable` の検証対象外であり、置換は呼び出し元の責務であること、delta 適用後に `resolveCatalogVariables` を呼べば置換後の参照切れを検出できることが明記される
- `src/msf.test.ts` に次のテストが追加される:
  - delta の add が `initRef: "%init%"` を持ち込んでも `applyCatalogDelta` は throw せず、合成結果の `initRef` は `%init%` のまま残る。`resolveInitData` は `undefined` を返し、`encodeCatalog` は `%init%` のまま受理する
  - delta の clone が `initRef: "%init%"` を上書きしても `applyCatalogDelta` は throw せず、合成結果の `initRef` は `%init%` のまま残る
  - 合成結果に `resolveCatalogVariables` を適用し、`initDataList` の id と一致する値で置換すれば `resolveInitData` がそのエントリの `data` を返す
  - 合成結果に `resolveCatalogVariables` を適用し、置換後の `initRef` が `initDataList` のどの id とも一致しなければ throw する (0692 の検証)
  - `initDataList` の id 側に `%` がある Catalog に delta を適用した場合も、置換後の検証は `resolveCatalogVariables` が行う
  - 変数を含まない delta の検証結果は従来どおりである
- `npx vp check` / `npx tsc --noEmit` / `npx vp test --run` が通る

## 参照

- draft-ietf-moq-msf-02 §5.1.6 (delta update の op) / §5.3 (Delta updates) / §5.4 (Variable Substitution) / §5.4.1 (Variable Syntax) / §5.4.2 (Variable Resolution。fragment 由来) / §5.2.14 (initRef) / §5.1.7 (initDataList)
- `src/msf/catalogDelta.ts` の `applyCatalogDelta`
- `src/msf/catalogValidation.ts` の `assertInitRefResolvable` (`%` を含む値を対象外にする条件)
- `src/msf/variables.ts` の `resolveCatalogVariables` (0692 で置換後の参照切れ検証を追加)
- `src/index.ts` の `applyCatalogDelta` の公開
- closed `0692-bug-catalog-init-ref-substitution-revalidation.md` (「残した課題」に本件がある)
- open `0853-bug-subscriber-variable-substitution.md` (購読経路への変数置換の組み込み)

## 解決方法

`applyCatalogDelta` は変数置換を行わない契約を JSDoc に明記し、テストで固定した。

- 置換は呼び出し元の責務であり、置換後の再検証は `resolveCatalogVariables` が行う
- delta が `%init%` を持ち込んだ場合、適用だけでは未解決のまま残り、`resolveCatalogVariables` を通した時点で参照切れまたは解決済みの値になることをテストで確認した
