# devtools 向け Vitest 受け入れ態勢を整備し純粋関数の単体テストを追加する

Created: 2026-05-11
Model: Opus 4.7

## 概要

`devtools/src/` 配下には単体テストが 1 つも存在せず、`vite.config.ts` の `test.include` も `src/**/*.{test,prop}.ts` のみで devtools は Vitest 対象外。issue #0134-0155 の大規模リファクタにもかかわらずテストが一切追加されていない状態は、CLAUDE.md「何か変更をする場合はテストを先に修正すること」を全面的に踏み外している。

本 issue では devtools 向けに Vitest を受け入れる構成を整え、以下の純粋関数 / 同期 signal 操作に対する最低限の単体テストを追加する:

- `sortByGroupObject` の非破壊性と正しい順序付け (#0147 回帰防止)
- `addSubscriber` / `removeSubscriber` / `getSubscriber` / `subscriberIds` / `hasActiveSubscriber` (#0134 回帰防止)
- `catalog timeout` の `clearTimeout` 解放 (#0154 回帰防止)
- `joiningFetch.onError` の decoder ガード (#0155 回帰防止)

## 根拠

- `vite.config.ts` 内 `test.include` が `src/**/*.{test,prop}.ts` のみで devtools/src 配下を含まない
- `devtools/src/` 配下に `*.test.ts` / `*.prop.ts` ファイルが 1 件も存在しない
- CLAUDE.md「何か変更をする場合はテストを先に修正すること」「Vitest の Chai API (test / assert) を利用すること」「モックやスタブは利用しないこと」「`*.prop.ts` というファイル名にすること」

## 修正方針

### 1. Vitest の include 拡張

`vite.config.ts` の `test.include` に `devtools/src/**/*.{test,prop}.ts` を追加する。

### 2. `sortByGroupObject` の export と単体テスト

`useSubscriber.ts` の `sortByGroupObject` を export し、以下を検証する `devtools/src/hooks/sortByGroupObject.test.ts` (もしくは抽出先ファイル名) を追加:

- 入力配列の length と各要素の順序が呼出し前後で変わらない (非破壊性)
- 戻り値は (groupId, objectId) 昇順
- 戻り値と入力が別オブジェクト (`result !== input`)
- BigInt 値を含む groupId / objectId が正しく比較される
- 空配列 / 単一要素のエッジケース

可能なら `*.prop.ts` で fast-check を用いて (groupId, objectId) のシャッフルに対する不変条件を網羅する。

### 3. `signals/subscriber.ts` の単体テスト

`devtools/src/signals/subscriber.test.ts` を追加:

- `addSubscriber()` が `subscriberInstances` Map を新規参照で置き換える
- `removeSubscriber(id)` が Map を新規参照に差し替え、`getSubscriber(id)` が undefined を返す
- `hasActiveSubscriber` が `instance.subscriber.value` の null / 非 null に同期して true / false を返す (実際の `signal()` で検証、モック禁止)
- `subscriberIds` が要素追加 / 削除に追従する
- `createSubscriberInstance(id)` で `.id === id` および他フィールドの初期値が期待通り

### 4. テスト実行確認

- `vp run test` で devtools 配下のテストも含めて全件パスすること
- 追加テスト件数は最低 10 件以上

## 影響範囲

- `vite.config.ts`
- `devtools/src/hooks/useSubscriber.ts` (`sortByGroupObject` の export)
- `devtools/src/hooks/sortByGroupObject.test.ts` (新規)
- `devtools/src/signals/subscriber.test.ts` (新規)

## テスト戦略

- 上記テストを追加し、`vp run test` で全件パスすることを確認する
- Catalog timeout や `joiningFetch.onError` の decoder ガードに対するテストは、関連する関数がリファクタされた後 (issue #0159) に追加するのが効率的なため、本 issue では一旦 pure 関数群に絞る

## CHANGES.md 記載方針

- `### misc` サブセクションに `[ADD]` で記載する

## 完了条件

- `vite.config.ts` の `test.include` に devtools 配下が含まれる
- `sortByGroupObject` の test が追加されている (最低 5 件以上)
- `signals/subscriber.ts` の test が追加されている (最低 5 件以上)
- `vp run test` が全件パスする
