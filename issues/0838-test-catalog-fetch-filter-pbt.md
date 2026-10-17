# catalogFetchFilter の不変条件を PBT で固定する

- Created: 2026-10-12
- Completed: {YYYY-MM-DD}
- Branch: feature/add-catalog-fetch-filter-pbt

## 目的

catalog の FETCH に載せる Location Filter を決める `catalogFetchFilter` は、次の不変条件を持つ。

- 返り値は常に定義済みである (Location Filter を省略した FETCH は実リレーで応答が返らないため)
- 開始位置の Group は Largest Object の Group 以下であり、Object は Group の先頭 (0) である

いまの単体テストは null / Group 0 / Group 7 の 3 例だけで、任意の値で成り立つことを固定していない。`fast-check` を使う規約に合わせ、任意の bigint で性質を固定する。

## 現状

- `src/createMediaSubscriber.test.ts` の `catalogFetchFilter` のテストは 3 例である (Largest Object が Group 7 のとき / Group 0 のとき / 不明なとき)
- `src/` の性質テストは `*.prop.ts` に置く規約で、`catalogFetchFilter` の prop ファイルは無い
- Group ID は `vi64` であり、0 と 2^64 - 1 の近傍が境界になる (draft-ietf-moq-transport-22 §8.1)

## 設計方針

- `src/createMediaSubscriber.prop.ts` を足す (`src/filter.prop.ts` / `src/msf.prop.ts` と同じ作法)
- Largest Object の Group / Object を任意の bigint として生成し、次を固定する
  - 返り値が常に定義済みである
  - 返り値の `startGroup` が Largest Object の Group 以下である
  - 返り値の `startObject` が 0 である (Group の先頭 Object は完全な catalog を持つ。draft-ietf-moq-msf-01 §5)
- 境界 (0 / 2^64 - 1) はジェネレータの端点として含める
- 例示の単体テスト (null / Group 0) は境界の固定として残す

## 完了条件

- `src/createMediaSubscriber.prop.ts` が追加され、`vp test run` の対象になる
- 反例が出た場合に縮小された入力が読める (`fc.assert` の既定のままでよい)
- 例示の単体テストは残る
- `vp check` / `tsc --noEmit` / `vp test run` が通る

## 参照

- `src/createMediaSubscriber.ts` の `catalogFetchFilter`
- `src/filter.prop.ts` / `src/msf.prop.ts` (prop ファイルの作法)
- `src/createMediaSubscriber.test.ts` (`catalogFetchFilter` の例示テスト)
- draft-ietf-moq-transport-22 §9.20.9 (LOCATION FILTER) / §8.1 (Variable-Length Integers)
- draft-ietf-moq-msf-01 §5 (catalog は Group の先頭 Object)
