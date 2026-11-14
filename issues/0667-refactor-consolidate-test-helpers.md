# テストのヘルパーと PBT の arbitrary の重複を共有モジュールへ集約する

- Created: 2026-09-21
- Completed: {YYYY-MM-DD}
- Branch: feature/refactor-consolidate-test-helpers
- Polished: 2026-11-14

## 目的

closed/0598 でテストコードの重複集約を行ったが、`src/message/*.prop.ts` には同型の検証ループと重複した arbitrary が残っている。同型コードは 1 箇所の修正が全箇所へ波及せず、テストが何を検証しているかを読み取りにくくする。集約の残りを片付ける。

## 現状

- `src/message/*.prop.ts` の 13 箇所に「デコードした Parameters を 1 件ずつ突き合わせる」同型ループがある (`namespace.prop.ts` 4 / `subscribe.prop.ts` 3 / `session.prop.ts` 2 / `fetch.prop.ts` 1 / `publish.prop.ts` 1 / `trackstatus.prop.ts` 1 / `parameter.prop.ts` 1)。いずれも件数比較の後で `type` と `value` を `for` で比較する同じ形である
- 3 箇所に「Track Properties はソートされるためソート後の値と比較する」同型ブロックがある (`publish.prop.ts` / `subscribe.prop.ts` / `session.prop.ts`)。`session.prop.ts` だけ件数比較がブロックの外にあり、他 2 箇所と位置が揃っていない
- 後続バイト列を連結して `ProtocolViolationError` を期待する同型ブロックは、`session.prop.ts` の GOAWAY テスト 1 箇所と、`publish.test.ts` / `trackstatus.test.ts` / `subscribe.test.ts` (2 箇所) / `fetch.test.ts` の 5 箇所にある (計 6 箇所)。`session.prop.ts` と `fetch.test.ts` は `withTrailing` の確保と連結処理をそのまま繰り返している
- `fc.array(fc.string({ minLength: 1, maxLength: 20 }), { minLength: 0, maxLength: 5 })` という生成条件は、`src/message/namespace.prop.ts` の `namespacePrefixStringsArb` / `namespaceSuffixStringsArb`、`src/message/parameterArb.ts` の `namespacePartsArb` / `namespaceArb` の 4 定義と、`namespace.prop.ts` の PUBLISH_SKIPPED テスト 1 箇所・`session.prop.ts` の Redirect テスト 2 箇所のインライン 3 箇所の計 7 箇所に現れる (`namespaceStringsArb` は `namespacePartsArb` の別名)
- `src/testSupport/helpers.ts` に Parameters 比較・Track Properties 比較・後続バイト付与のヘルパーが無い

## 設計方針

- `src/testSupport/helpers.ts` に Parameters 比較・Track Properties 比較・後続バイト付与のヘルパーを追加する。Parameters 比較と Track Properties 比較は各 `*.prop.ts` から呼び、後続バイト付与は `*.prop.ts` / `*.test.ts` から呼ぶ。`session.prop.ts` の件数比較の位置ずれもヘルパー側で吸収する
- arbitrary は `src/message/parameterArb.ts` に寄せる。テストを含むファイルを共有元にすると import 元ごとにテストが重複登録される (closed/0598 で確認済み)
- 上記の生成条件を持つ定義は、名前付き (`namespace.prop.ts` の `namespacePrefixStringsArb` / `namespaceSuffixStringsArb`)・インライン (`namespace.prop.ts` の PUBLISH_SKIPPED 1 箇所 / `session.prop.ts` の Redirect 2 箇所)・同条件の `namespaceArb` を問わず `namespacePartsArb` に一本化する。`namespaceStringsArb` は `namespacePartsArb` の別名のままにする
- テストの件数と検証内容は減らさない

## 完了条件

- Parameters 比較・Track Properties 比較・後続バイト付与の各ヘルパーが `src/testSupport/helpers.ts` の 1 定義になり、上記の呼び出し箇所がそれを参照している
- `fc.array(fc.string({ minLength: 1, maxLength: 20 }), { minLength: 0, maxLength: 5 })` の生成条件が `src/message/parameterArb.ts` の `namespacePartsArb` の 1 定義だけになる
- テスト総数が減っていない
- `pnpm test` が通る

## 参照

- closed/0598 (テストヘルパーと PBT arbitrary の集約。本 issue はその残り)
- `src/testSupport/helpers.ts` / `src/message/parameterArb.ts` / `src/message/namespace.prop.ts`

## 解決方法

{未着手}
