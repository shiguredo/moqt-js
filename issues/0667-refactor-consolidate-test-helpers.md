# テストのヘルパーと PBT の arbitrary の重複を共有モジュールへ集約する

- Created: 2026-09-21
- Completed: {YYYY-MM-DD}
- Branch: feature/refactor-consolidate-test-helpers
- Polished: {YYYY-MM-DD}

## 目的

closed/0598 でテストコードの重複集約を行ったが、`src/message/*.prop.ts` には同型の検証ループと重複した arbitrary が残っている。同型コードは 1 箇所の修正が全箇所へ波及せず、テストが何を検証しているかを読み取りにくくする。集約の残りを片付ける。

## 現状

- `src/message/*.prop.ts` の 13 箇所に「デコードした Parameters を 1 件ずつ突き合わせる」同型ループがある (`namespace.prop.ts` 3 / `subscribe.prop.ts` 3 / `fetch.prop.ts` 2 / `publish.prop.ts` 2 / `session.prop.ts` 2 / `trackstatus.prop.ts` 1)。いずれも件数比較の後で `type` と `value` を `for` で比較する同じ形である
- 4 箇所に「Track Properties はソートされるためソート後の値と比較する」同型ブロックがある (`publish.prop.ts` / `subscribe.prop.ts` / `fetch.prop.ts` / `session.prop.ts`)。`session.prop.ts` だけ件数比較がブロックの外にあり、他 3 箇所と位置が揃っていない
- 13 箇所に「正常な payload の後ろに後続バイト列を連結して `ProtocolViolationError` を期待する」同型ブロックがある (`namespace.prop.ts` 6 / `session.prop.ts` 2 / `subscribe.prop.ts` 2 / `fetch.prop.ts` 1 / `publish.prop.ts` 1 / `trackstatus.prop.ts` 1)。`withTrailing` の確保と 2 回の `set` がそのまま繰り返されている
- `src/message/namespace.prop.ts` の `namespacePrefixStringsArb` と `namespaceSuffixStringsArb` は本体が完全一致し、`src/message/parameterArb.ts` の `namespacePartsArb` とも同一条件 (`fc.array(fc.string({ minLength: 1, maxLength: 20 }), { minLength: 0, maxLength: 5 })`) である。3 つが同じ生成条件を別名で持っている
- `src/testSupport/helpers.ts` に比較・後続バイト付与のヘルパーが無い

## 設計方針

- `src/testSupport/helpers.ts` に Parameters 比較・Track Properties 比較・後続バイト付与のヘルパーを追加し、各 `*.prop.ts` はそれを呼ぶ。`session.prop.ts` の件数比較の位置ずれもヘルパー側で吸収する
- arbitrary は `src/message/parameterArb.ts` に寄せる。テストを含むファイルを共有元にすると import 元ごとにテストが重複登録される (closed/0598 で確認済み)
- `src/message/namespace.prop.ts` の 2 つの arbitrary は `namespacePartsArb` に一本化する
- テストの件数と検証内容は減らさない

## 完了条件

- 上記の同型ループ・同型ブロック・重複 arbitrary が 1 箇所の定義になる
- テスト総数が減っていない
- `pnpm test` が通る

## 参照

- closed/0598 (テストヘルパーと PBT arbitrary の集約。本 issue はその残り)
- `src/testSupport/helpers.ts` / `src/message/parameterArb.ts` / `src/message/namespace.prop.ts`

## 解決方法

{未着手}
