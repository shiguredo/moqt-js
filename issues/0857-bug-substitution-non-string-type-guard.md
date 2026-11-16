# 変数置換と delta 適用で string 以外の値に当たると TypeError になる

- Created: 2026-10-14
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-substitution-non-string-type-guard
- Polished: 2026-11-15
- Refreshed: 2026-11-14

## 目的

MSF モジュールの契約は「検証違反は plain `Error` で throw する」である (0693 で encode 側にも広げた)。しかし `resolveCatalogVariables` は、置換対象の string フィールドが実行時に string でない場合 (`initDataList` の `id` / `type` / `data`、`tracks` / `publishTracks` の要素が `null`、`depends` の要素、`accessibility` の `scheme` / `value`、`publishTracks` の `connectionUri` / `token` など) に `TypeError` を投げる。`applyCatalogDelta` も、引き継いだ `initDataList` の `id` が string でない場合に `assertInitRefResolvable` の `entry.id.includes` で `TypeError` を投げる。Catalog の型では表現できない入力 (JavaScript から組み立てた値) が対象だが、同じクラスの入力に対して `initRef` は 0692 で型ガードを入れており、扱いが揃っていない。

## 現状

- `src/msf/variables.ts` の `substituteString` は `value.replaceAll` を呼ぶため、string 以外を渡されると `TypeError: value.replaceAll is not a function` になる。`initDataList[].id` / `type` / `data`、`depends` の要素、`accessibility[].scheme` / `value`、`publishTracks[].connectionUri` / `token` が該当する (既知の単純 string フィールドは `substituteTrack` の `typeof value === "string"` で守られている)
- `substituteInitDataEntry` は `initDataList` の要素が `null` / `undefined` の場合に `Cannot read properties of null (reading 'id')` / `Cannot read properties of undefined (reading 'id')` になる。`substituteTrack` は `tracks` / `publishTracks` の要素が `null` / `undefined` の場合に `Cannot read properties of null (reading 'name')` / `Cannot read properties of undefined (reading 'name')` になる。`substituteTrack` は `authInfo` が `null` の場合に `Object.entries` で、`accessibility` の要素が `null` の場合に `entry.scheme` の読み取りで TypeError になる
- `assertInitRefResolvable` は `initDataList` の id を型確認なしで `includes` に渡すため、id が string でない場合に `TypeError: entry.id.includes is not a function` になる。同じ関数は track の `initRef` を型確認なしで読むため、`tracks` / `publishTracks` に `null` / `undefined` の要素があると `Cannot read properties of null (reading 'initRef')` / `Cannot read properties of undefined (reading 'initRef')` になる。`initDataList` に `null` / `undefined` の要素があると `Cannot read properties of null (reading 'id')` / `Cannot read properties of undefined (reading 'id')` になる
- 実測 (2026-11-15): `resolveCatalogVariables` に `initDataList: [{id: 123, type: "inline", data: "AAAA"}]` を渡すと `TypeError: value.replaceAll is not a function`。`applyCatalogDelta` に `current.initDataList: [{id: 123, type: "inline", data: "AAAA"}]` を渡すと `TypeError: entry.id.includes is not a function`。`encodeCatalog` に同じ Catalog を渡すと `Error: invalid initDataList entry at index 0: id must be a string per §5.1.7, got number` になる
- 0692 で `assertInitRefResolvable` の `initRef` には「文字列でなければ無視する」型ガードを入れた。decode 経路は `pickOptionalString` (`initRef`) と `validateInitDataEntry` (`initDataList` の `id` / `type` / `data`) が型を強制するため、この問題は型を迂回した入力でのみ到達する
- 公開 API の `applyCatalogDelta` は `src/index.ts` から公開されており、`resolveCatalogVariables` は `src/msf.ts` までである

## 設計方針

- 置換経路 (`resolveCatalogVariables`) で、置換対象の値が string でない場合は TypeError を出さずにその値をそのまま返す (型の検証は decode 側の責務。手組みの Catalog は decode を通らない)。`substituteString` に到達するすべての string フィールド (上記の `initDataList` / `depends` / `accessibility` / `publishTracks` を含む) を対象にする。`substituteTrack` / `substituteInitDataEntry` は要素が object でない場合もそのまま返す。`substituteTrack` は `authInfo` が `null` の場合と `accessibility` の要素が `null` / `undefined` の場合もそのまま返す
- `assertInitRefResolvable` は、track が object でない場合はその track を無視する。`initDataList` の要素が object でない場合、または id が string でない場合は、`%` を含む場合と同じく参照切れ検証を打ち切る (id 集合が string だけではないため参照先を判定できない。型の検証は decode 側の責務)。これにより `resolveCatalogVariables` が素通りさせた `null` の track / `initDataList` 要素でも TypeError にならない
- `applyCatalogDelta` は `assertInitRefResolvable` を共有するため、引き継いだ `initDataList` の id が string でない場合は TypeError を出さず、参照切れ検証を打ち切って合成結果を返す。合成結果の型違反は `encodeCatalog` が decode 側の型検証で拒否する。wire から decode した Catalog は id が string であるため、通常の公開 API 利用では挙動は変わらない
- 素通りさせた Catalog は送信時に `encodeCatalog` が decode 側の型検証で拒否する。この関係を `resolveCatalogVariables` / `assertInitRefResolvable` / `applyCatalogDelta` の JSDoc に明記する (JSDoc に issue 番号は書かない)。`assertInitRefResolvable` の既存のインラインコメント (「initDataList の id は文字列前提のままで、崩れていれば TypeError になる」) も新しい挙動に合わせて更新する
- `applyCatalogDelta` の JSDoc は 0856 が変数を含む `initRef` の扱いを追記する予定であり、両方を同時に反映する
- 対象は `src/msf/variables.ts` / `src/msf/catalogValidation.ts` / `src/msf/catalogDelta.ts` (JSDoc) / `src/msf.test.ts`
- CODEBASE.md の「MOQT RFC ドラフト中の特別ルール」に従い、`CHANGES.md` は更新しない

## 完了条件

- `resolveCatalogVariables` に string 以外の値 (`initDataList[].id` / `type` / `data`、`depends` の要素、`accessibility[].scheme` / `value`、`publishTracks[].connectionUri` / `token`、`tracks` / `publishTracks` の `null` / `undefined` 要素、`initDataList` の `null` / `undefined` 要素、`authInfo: null`、`accessibility: [null] / [undefined]`) を渡しても `TypeError` にならない
- 非 string 値 / null 要素は置換で別の値に変わらず、そのまま返る
- `applyCatalogDelta` に `initDataList` の id が string でない `current` を渡しても `TypeError` にならず、参照切れ検証を打ち切った合成結果を返す。この挙動がテストで固定される
- 正当な入力の置換結果は変わらない
- `resolveCatalogVariables` / `assertInitRefResolvable` / `applyCatalogDelta` の JSDoc と、`assertInitRefResolvable` の既存のインラインコメントに、非 string 値を素通りさせ、`encodeCatalog` が decode 側の型検証で拒否する関係が明記される
- `src/msf.test.ts` に上記の非 string 値 / null 要素 / 非 string id のテストと、`encodeCatalog` が同じ入力を plain `Error` で拒否することのテストが追加される
- `npx vp check` / `npx tsc --noEmit` / `npx vp test --run` が通る

## 参照

- draft-ietf-moq-msf-02 §5.1.7 (initDataList の `id` / `type` / `data` は string) / §5.2.14 (initRef は string) / §5.4 (Variable Substitution)。本文は `refs/moq/draft-ietf-moq-msf-02.txt`
- `src/msf/variables.ts` の `resolveCatalogVariables` / `substituteString` / `substituteInitDataEntry` / `substituteTrack`
- `src/msf/catalogValidation.ts` の `assertInitRefResolvable` (0692 で `initRef` の型ガードを追加) / `validateInitDataEntry`
- `src/msf/catalogDelta.ts` の `applyCatalogDelta`
- `src/index.ts` の `applyCatalogDelta` の公開
- `src/msf/catalogCodec.ts` の `encodeCatalog` (decode 側の検証を共有する)
- `src/msf/catalogTrackValidation.ts` の `pickOptionalString` (decode 側の `initRef` の型検証)
- `src/msf.ts` の「検証違反は plain `Error`」の契約コメント
- closed `0692-bug-catalog-init-ref-substitution-revalidation.md` (「残した課題」に本件がある)
- closed `0693-bug-encode-catalog-validation.md` (encode 側にも decode と同じ検証を広げた)
- open `0854-bug-substitution-conditional-must-revalidation.md` / `0855-bug-substitution-duplicate-revalidation.md` / `0856-bug-catalog-delta-variable-init-ref.md` (`variables.ts` / `catalogValidation.ts` / `catalogDelta.ts` のいずれかを触るが、検証内容は重ならない)

## 解決方法

{未着手}
