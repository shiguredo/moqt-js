# テストコードの重複ヘルパーと PBT arbitrary を共有モジュールに集約する

- Created: 2026-09-13
- Completed: {YYYY-MM-DD}
- Branch: feature/refactor-test-support-dedup
- Polished: {YYYY-MM-DD}

## 目的

テストコードが 49,546 行 (`src/**/*.test.ts` 41,211 行 + `src/**/*.prop.ts` 7,078 行 + devtools のテスト 1,257 行) に達し、実装コード (非テスト・非 PBT の `src` 34,014 行) を上回っている。増加分の相当部分はテスト用ヘルパーと PBT の arbitrary を各ファイルが個別に再定義していることが原因で、同一実装が 2〜7 箇所に散っている。

放置すると次のコストが発生し続ける。

- 共通ヘルパーの仕様変更 (例: `MoqtObject` のフィールド追加) で同じ修正を 3〜5 箇所に入れる必要がある
- 同名で中身が違う arbitrary が生まれ、テストが何を検証しているか読めなくなる
- 新規テストを書くたびに 6〜27 行のコピーが増える

重複を共有モジュールに集約して 1 箇所保守にし、テストコードを約 1,000 行削減する。

## 現状

共有テストヘルパ置き場が存在しない (`tests/` は e2e 専用、`src/` 配下に test util ディレクトリなし、`.prop.ts` 間の相互 import は 0 件)。そのため以下が重複している。

### テストヘルパー (完全一致を確認済み)

- `concatUint8Arrays` が `src/session/bidi.test.ts` / `src/session/incoming.test.ts` / `src/session/publish.test.ts` / `src/session.test.ts` の 4 テストファイルに同名・同一実装で定義されている。production 側の `src/message/parameter.ts` にも private 実装があり、`src/session/stream.ts` には export 済みの `concatChunks` が既にある (同じ配列連結)。
- `src/session.test.ts` の `concatUint8ArraysForTest` は `concatUint8Arrays` の改名コピー。
- `nodeProcess` (`globalThis` から `process` を取り出す 9 行) が `src/session.test.ts` と `src/session/bidi.test.ts` に重複。unhandled rejection を 50ms 待って検証する同型ロジックも 3 ファイルに散在する。
- `createObject(groupId, objectId)` が `src/subscriber.test.ts` / `src/subscriber.prop.ts` / `src/fetcher.test.ts` に重複。
- `appendMalformedTrackProperties` が `src/session/bidi.test.ts` と `src/session/namespaceLoops.test.ts` に完全一致で重複。
- ほかに `useValueToken` / `encodeJson` / `parseObjectPropertyIds` / `assertRejectsWithMessage` が各 2 ファイルに重複。

### PBT の arbitrary (`src/message/*.prop.ts` の 7 ファイル)

`src/message/parameter.prop.ts` / `namespace.prop.ts` / `fetch.prop.ts` / `publish.prop.ts` / `subscribe.prop.ts` / `session.prop.ts` / `trackstatus.prop.ts` の 7 ファイルは合計 2,969 行で、`uint8ParameterArb` / `locationParameterArb` / `lengthPrefixedParameterArb` / `locationFilterParameterArb` / `messageParameterArb` / `parametersArb` が 7 ファイルすべてに再定義されている。ブロック単位の機械比較では本体が完全一致する定義が 15 ブロックあり、1 ファイルに 1 つだけ残す前提で **507 行が重複**している。内訳は `locationFilterParameterArb` 27 行 x 6 / `locationParameterArb` 13 行 x 7 / `uint8ParameterArb` 11 行 x 7 / `evenPropertyArb` 14 行 x 4 / `lengthPrefixedParameterArb` 6 行 x 7 / `oddPropertyArb` 11 行 x 4 / `parametersArb` 6 行 x 6 / `messageParameterArb` 7 行 x 5 / `varintParameterArb` 6 行 x 4 と 6 行 x 3 / `namespaceStringsArb` 4 行 x 4 / `trackNameArb` 3 行 x 4 ほか。

`evenPropertyArb` / `oddPropertyArb` / `propertyArb` / `trackPropertiesArb` も `src/properties.prop.ts` と `src/message/{publish,subscribe,fetch,session}.prop.ts` に重複している (message 側の 3 ファイルは先頭コメント以外完全一致)。

`namespaceStringsArb` と `trackNameArb` は各 4 ファイルで完全一致。`src/message/namespace.prop.ts` の `namespacePrefixStringsArb` と `namespaceSuffixStringsArb` は同一本体内で同一ジェネレータを別名定義している。

### 統合時に注意すべき非対称 (重要)

- `varintParameterArb` の型リストがファイル間で異なる。`parameter.prop.ts` / `publish.prop.ts` / `subscribe.prop.ts` は `0x02, 0x04, 0x06, 0x08, 0x32`、`fetch.prop.ts` / `trackstatus.prop.ts` / `session.prop.ts` / `namespace.prop.ts` は `0x06` を含まない `0x02, 0x04, 0x08, 0x32`。どのメッセージに 0x06 が出現できるかの差を反映しているため、**単純に一方へ寄せてはならない**。型リストを引数に取るジェネレータ関数にするか、用途別に 2 つ定義して名前で区別する。
- `parametersArb` は `parameter.prop.ts` 版だけが Range Filter の重複 SetID を除去する強化版で、他 6 ファイルは単純版である。**同名で中身が違う**ため、統合後はどちらを正とするかを決めてテストで確認する。
- `locationFilterArb` は `parameter.prop.ts` と `session.prop.ts` の 2 箇所に完全一致で存在する。

## 設計方針

1. テスト専用の共有モジュールを 1 つ作る。ファイル名は vitest の `test.include` (`src/**/*.{test,prop}.ts`) に一致させないこと。一致させるとテストを含まないファイルがテストファイルとして収集される。
2. `concatUint8Arrays` は新規実装を足さず、`src/session/stream.ts` が既に export している `concatChunks` を再利用する。`src/message/parameter.ts` の private 実装も同じヘルパに置き換える。
3. PBT の arbitrary は `src/message/parameter.prop.ts` を共有元にする。同ファイルは既に `locationFilterArb` / `rangeFilterParameterArb` / `parametersArb` を持ち、7 ファイル中で最も強化された定義を含む。他 6 ファイルは import に置き換える。
4. `varintParameterArb` は型リストの差を引数で表現する。型リストを狭めない (テストの探索空間を縮めない) ことを優先し、広い側に寄せてテストが通るかを実行して確認する。
5. テストの件数と検証内容は減らさない。既存の 2,045 テストがすべて通ることを維持する。

## 完了条件

- 上記の重複ヘルパーがすべて 1 箇所の定義になり、各テストファイルは import で参照していること。
- `src/message/*.prop.ts` の 7 ファイルから Parameter / Track Property 系 arbitrary の再定義が消え、共有元を参照していること。
- テストコードの合計行数が 1,000 行以上減っていること。
- テスト総数が減っていないこと (現在 69 ファイル / 2,045 テスト)。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。
- `CHANGES.md` の `## develop` の `### misc` に該当する変更種別のエントリを追加すること。

## 参照

- `src/message/parameter.prop.ts` (`parametersArb` / `locationFilterArb` / `rangeFilterParameterArb`)
- `src/session/stream.ts` (`concatChunks`)
- `src/message/parameter.ts` (private `concatUint8Arrays`)
- `src/session/bidi.test.ts` / `src/session.test.ts` / `src/session/incoming.test.ts` / `src/session/publish.test.ts` / `src/session/namespaceLoops.test.ts`
- `src/subscriber.test.ts` / `src/subscriber.prop.ts` / `src/fetcher.test.ts`
- `src/properties.prop.ts` / `src/message/{publish,subscribe,fetch,session,trackstatus,namespace}.prop.ts`
- `issues/0547-refactor-subscribe-prop-namespace-arb.md` (subscribe.prop.ts 内に閉じた namespace arbitrary の重複。本 issue はファイル横断の重複を扱う)
- `issues/0576-refactor-bidi-test-split.md` (bidi.test.ts の分割と共通ヘルパー抽出。本 issue はテストファイル横断の重複を扱う)
- `issues/0597-refactor-namespace-loop-test-parametrize.md` (namespaceLoops.test.ts の鏡写しテストのテーブル化。本 issue は共有ヘルパーを扱う)

## 進捗

テストヘルパーの統合は完了した。

- `src/testSupport/helpers.ts` を新設し、`concatUint8Arrays` / `nodeProcess` / `createObject` / `appendMalformedTrackProperties` / `parseObjectPropertyIds` / `assertRejectsWithMessage` / `encodeJson` / `useValueToken` を集約した。21 ファイルから重複定義を削除し、18 ファイルで +163 / -217 行。
- `useValueToken` は `tokenValue` の文字列だけが違っていたため引数化した。
- テストの検証内容と件数は変えていない (70 ファイル / 2,090 テスト全通過)。

残りは `src/message/*.prop.ts` の 7 ファイルに散在する PBT arbitrary の重複 15 ブロック / 507 行である。着手時に次の統合上の罠が判明しているため、別の作業単位として扱う。

- `varintParameterArb` の型リストがファイル間で非対称 (`parameter.prop.ts` / `publish.prop.ts` / `subscribe.prop.ts` は `0x06` を含み、`fetch.prop.ts` / `trackstatus.prop.ts` / `session.prop.ts` / `namespace.prop.ts` は含まない)。広い側に寄せると PBT の探索空間が広がるため、統合後にテストが通るかを実行して確認する必要がある。
- `parametersArb` は `parameter.prop.ts` 版だけが Range Filter の重複 SetID を除去する強化版で、他 6 ファイルは type 重複除去のみの単純版である。同名で中身が違うため、どちらを正とするかを決める必要がある。
- `src/properties.prop.ts` の `evenPropertyArb` / `oddPropertyArb` は生成方法が message 側と異なる (ID の作り方が `fc.bigInt({ min: 0n, max: 0xfen })` と `fc.bigInt({ min: 0n, max: 100n }).map((n) => n * 2n)` で違う)。
