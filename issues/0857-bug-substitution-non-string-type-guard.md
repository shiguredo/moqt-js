# 変数置換で string 以外の値に当たると TypeError になる

- Created: 2026-10-14
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-substitution-non-string-type-guard

## 目的

MSF モジュールの契約は「検証違反は plain `Error` で throw する」である (0693 で encode 側にも広げた)。しかし `resolveCatalogVariables` は、置換対象の string フィールドが実行時に string でない場合 (`initDataList` の `id` / `type` / `data`、`tracks` の要素が `null` など) に `TypeError` を投げる。Catalog の型では表現できない入力 (JavaScript から組み立てた値) が対象だが、同じクラスの入力に対して `initRef` は 0692 で型ガードを入れており、扱いが揃っていない。

## 現状

- `src/msf/variables.ts` の `substituteString` は `value.replace` を呼ぶため、string 以外を渡されると `TypeError: value.replace is not a function` になる (`initDataList[].id` / `type` / `data` が該当)
- `substituteInitDataEntry` / `substituteTrack` は `tracks` の要素が `null` の場合に `Cannot read properties of null (reading 'name')` になる
- 実測: `resolveCatalogVariables` に `initDataList: [{id: 123, ...}]` を渡すと TypeError。`applyCatalogDelta` に `initDataList: [{id: 123}]` を渡すと `assertInitRefResolvable` の `entry.id.includes` で TypeError
- 0692 で `assertInitRefResolvable` の `initRef` には「文字列でなければ無視する」型ガードを入れた。decode 経路は `pickOptionalString` が型を強制するため、この問題は型を迂回した入力でのみ到達する
- 公開 API の `applyCatalogDelta` は `src/index.ts` から公開されており、`resolveCatalogVariables` は `src/msf.ts` までである

## 設計方針

- 置換経路 (`resolveCatalogVariables`) で、置換対象の値が string でない場合は TypeError を出さずに素通りさせる (型の検証は decode 側の責務。手組みの Catalog は decode を通らない)
- `assertInitRefResolvable` の `initDataList` の id も同じ扱いにするか、`id` を読む前に型を確かめる。どちらに揃えるかは実装時に決める (`src/msf.ts` の「検証違反は plain `Error`」の契約と 0692 の判断に合わせる)
- 素通りさせた Catalog は送信時に `encodeCatalog` が decode 側の型検証で拒否する。この関係を JSDoc に明記する
- 対象は `src/msf/variables.ts` / `src/msf/catalogValidation.ts` / `src/msf.test.ts`

## 完了条件

- `resolveCatalogVariables` に string 以外の値 (`initDataList[].id` / `type` / `data`、`tracks` の `null` 要素) を渡しても `TypeError` にならない
- 正当な入力の置換結果は変わらない
- `applyCatalogDelta` の `initDataList` の id が string でない場合の挙動が決まり、テストで固定される
- `npx vp check` / `npx tsc --noEmit` / `npx vp test --run` が通る

## 参照

- `src/msf/variables.ts` の `resolveCatalogVariables` / `substituteString` / `substituteInitDataEntry` / `substituteTrack`
- `src/msf/catalogValidation.ts` の `assertInitRefResolvable` (0692 で `initRef` の型ガードを追加)
- `src/msf.ts` の「検証違反は plain `Error`」の契約コメント
- closed `0692-bug-catalog-init-ref-substitution-revalidation.md` (「残した課題」に本件がある)

## 解決方法

{未着手}
