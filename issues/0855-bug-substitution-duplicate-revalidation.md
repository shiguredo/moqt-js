# 変数置換で生じる track 名 / initDataList の id 重複を検証しない

- Created: 2026-10-14
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-substitution-duplicate-revalidation

## 目的

§5.4 の変数置換は `name` と `initDataList` の `id` にも適用される。別々の値だったフィールドが同じ変数で置換されると、置換後に §5.2.3 の track 名重複や §5.1.7 の id 重複が生じる。`resolveCatalogVariables` は置換後の重複を検証しないため、そのような Catalog がそのまま後段へ渡る。送信経路では `encodeCatalog` が拒否するが、購読側のように in-memory で `resolveInitData` に渡す経路では、重複した id の先頭が黙って選ばれる (誤った初期化データで configure へ進む)。

## 現状

- `src/msf/variables.ts` の `substituteTrack` / `substituteInitDataEntry` は `name` / `namespace` / `id` を置換する
- `resolveCatalogVariables` は 0692 で `assertInitRefResolvable` のみを呼ぶ。JSDoc に「置換によって初めて生じる §5.2.3 の重複と §5.1.7 の id 重複は検証しない (送信時の `encodeCatalog` が拒否する。`resolveInitData` で解決する場合は先頭の一致で解決されるため沈黙する)」と明記している
- 実測: `initDataList: [{id: "%a%"}, {id: "x"}]` に `{a: "x"}` を適用すると id が重複した Catalog が返る。`encodeCatalog` は `duplicate initDataList id 'x' ... per §5.1.7` で拒否し、`resolveInitData` は先頭の一致を返す
- `src/msf/catalogValidation.ts` の `assertTrackNameUnique` と `validateCatalog` の id 重複検証は decode 経路のためのもので、置換後の Catalog には呼ばれない

## 設計方針

- 置換後に `assertTrackNameUnique` (§5.2.3。(name, namespace) の一意性) と id の一意性検証 (§5.1.7) を実行する。decode 側と同じ関数・同じ文言を使う
- 0692 と同じ理由で `validateCatalog` 全体は再実行しない (型・必須フィールドの検証は 0854 が扱う)
- 参照切れ (0692) と条件付き MUST (0854) は別 issue とし、本 issue は重複に限定する
- 従来受理していた Catalog を拒否する破壊的変更になる。`CHANGES.md` は CODEBASE.md の「MOQT RFC ドラフト中の特別ルール」に従い更新しない
- 対象は `src/msf/variables.ts` / `src/msf.test.ts`

## 完了条件

- 置換後に (name, namespace) が重複する Catalog を `resolveCatalogVariables` が reject する (文言は decode 側と同一)
- 置換後に `initDataList` の id が重複する Catalog を reject する
- 置換後も重複しない Catalog は従来どおり返る
- `npx vp check` / `npx tsc --noEmit` / `npx vp test --run` が通る

## 参照

- draft-ietf-moq-msf-01 §5.4 (Variable Substitution) / §5.2.3 (track 名の一意性) / §5.1.7 (initDataList の id は catalog 内で unique)
- `src/msf/variables.ts` の `resolveCatalogVariables` / `substituteTrack` / `substituteInitDataEntry`
- `src/msf/catalogValidation.ts` の `assertTrackNameUnique` / id 重複検証
- `src/msf/tracks.ts` の `resolveInitData`
- closed `0692-bug-catalog-init-ref-substitution-revalidation.md` (置換後の検証を initRef に限定した。本件は「残した課題」にある)

## 解決方法

{未着手}
