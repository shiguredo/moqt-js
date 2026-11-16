# 変数置換で生じる track 名 / initDataList の id 重複を検証しない

- Created: 2026-10-14
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-substitution-duplicate-revalidation
- Polished: 2026-11-15

## 目的

§5.4 の変数置換は `name` / `namespace` と `initDataList` の `id` にも適用される。別々の値だったフィールドが同じ変数で置換されると、置換後に §5.2.3 の track 名重複や §5.1.7 の id 重複が生じる。`resolveCatalogVariables` は置換後の重複を検証しないため、そのような Catalog がそのまま後段へ渡る。送信経路では `encodeCatalog` が拒否するが、購読側のように in-memory で `resolveInitData` に渡す経路では、重複した id の先頭が黙って選ばれる (誤った初期化データで configure へ進む)。

## 現状

- `src/msf/variables.ts` の `substituteTrack` / `substituteInitDataEntry` は `name` / `namespace` / `id` を置換する
- `resolveCatalogVariables` は 0692 で置換後の検証として `assertInitRefResolvable` のみを呼ぶ。JSDoc に「置換によって初めて生じる §5.2.3 の重複と §5.1.7 の id 重複は検証しない (送信時の `encodeCatalog` が拒否する。`resolveInitData` で解決する場合は先頭の一致で解決されるため沈黙する)」と明記している
- 実測: `initDataList: [{id: "%a%", type: "inline", data: "AAAA"}, {id: "x", type: "inline", data: "BBBB"}]` に `{a: "x"}` を適用すると id が重複した Catalog が返る。`encodeCatalog` は `duplicate initDataList id 'x' ... per §5.1.7` で拒否し、track の `initRef` が `x` のとき `resolveInitData` は先頭の一致 (`AAAA`) を返す
- `src/msf/catalogValidation.ts` の `assertTrackNameUnique` (decode と delta 合成で使う) と `validateCatalog` の id 重複検証 (decode 側の検証) は、置換後の Catalog には呼ばれない

## 設計方針

- 置換後に `assertTrackNameUnique` (§5.2.3 の (name, namespace) の一意性) と `initDataList` の id の一意性検証 (§5.1.7) を実行する。`assertTrackNameUnique` は `src/msf/catalogValidation.ts` から import して共用する。id の一意性検証は `validateCatalog` のインライン検証を `assertInitDataIdUnique` という関数として `src/msf/catalogValidation.ts` に切り出し、decode 側と置換側の両方から呼ぶ。エラー文言は decode 側と同一にする
- 置換後の検証順は decode 側 (`validateCatalog`) の該当検証と同じく、track 名の一意性 → `initDataList` の id の一意性 → `initRef` の参照切れとする
- 0692 と同じ理由で `validateCatalog` 全体は再実行しない。型・必須フィールドの検証結果は置換で変わらないため再実行せず、置換で値が変わる `role` / `codec` が条件の MUST は 0854 が扱う
- 参照切れ (0692) と条件付き MUST (0854) は別 issue とし、本 issue は重複に限定する
- 従来受理していた Catalog を拒否する破壊的変更になる (ただし `resolveCatalogVariables` は `src/index.ts` に再輸出されておらず、公開パッケージの API ではない)。`CHANGES.md` は CODEBASE.md の「MOQT RFC ドラフト中の特別ルール」に従い更新しない
- `src/msf/variables.ts` の JSDoc とモジュールヘッダの検証内容の記述を、重複も再検証する内容に更新する
- 対象は `src/msf/variables.ts` / `src/msf/catalogValidation.ts` / `src/msf.test.ts`

## 完了条件

- 置換後に (name, namespace) が重複する Catalog を `resolveCatalogVariables` が reject する (tracks と publishTracks の両方。文言は decode 側と同一)
- 置換後に `initDataList` の id が重複する Catalog を reject する (文言は decode 側と同一)
- 置換後も重複しない Catalog は従来どおり返る
- `src/msf.test.ts` に、置換後の track 名重複 (tracks / publishTracks)、id 重複、重複しない場合のテストが追加される
- `src/msf/variables.ts` の JSDoc とモジュールヘッダが新しい挙動に合っている
- `npx vp check` / `npx tsc --noEmit` / `npx vp test --run` が通る

## 参照

- draft-ietf-moq-msf-02 §5.4 (Variable Substitution) / §5.2.3 (track 名の一意性) / §5.1.7 (initDataList の id は catalog 内で unique)。本文は `refs/moq/draft-ietf-moq-msf-02.txt`
- `src/msf/variables.ts` の `resolveCatalogVariables` / `substituteTrack` / `substituteInitDataEntry`
- `src/msf/catalogValidation.ts` の `assertTrackNameUnique` / `validateCatalog` の id 重複検証 (実装時に `assertInitDataIdUnique` として切り出す)
- `src/msf/tracks.ts` の `resolveInitData`
- closed `0692-bug-catalog-init-ref-substitution-revalidation.md` (置換後の検証を initRef に限定した。本件は「残した課題」にある)
- open `0853-bug-subscriber-variable-substitution.md` (購読経路に変数置換を組み込む。置換結果を in-memory で使う経路の例)
- open `0854-bug-substitution-conditional-must-revalidation.md` (role / codec が条件の MUST。本 issue は重複に限定する)

## 解決方法

{未着手}
