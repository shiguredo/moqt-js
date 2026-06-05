# PBT の oddPropertyArb が再帰的 IMMUTABLE_PROPERTIES を生成して flaky に fail するのを修正する

- Priority: Medium
- Created: 2026-06-05
- Completed: 2026-06-05
- Model: Opus 4.8
- Branch: feature/fix-prop-arb-recursive-immutable-properties
- Reporter: @voluntas

## 目的

PBT の `oddPropertyArb` (複数の `*.prop.ts` に重複) が IMMUTABLE_PROPERTIES (id `0x0b` = 11) を任意バイトの data 付きで生成するため、data が再帰的に IMMUTABLE_PROPERTIES キーを含む malformed な入力を作り、`decodeProperties` が仕様通り `MalformedTrackError` を throw して CI が seed 依存で flaky に fail する。これを修正する。

## 優先度根拠

production コードのバグではなくテストジェネレータのバグだが、CI の `build` job が seed 依存でランダムに fail し、マージゲートの信頼性を損なう。実際に PR #57 の CI で `build (22)` が seed `1516739457` で fail し、rerun で pass した (他の Node version の build は同一コードで pass)。テスト専用かつ rerun で回避可能だが、全 PR の CI 安定性に影響するため Medium。

## 現状

`src/message/fetch.prop.ts:112-117` の `oddPropertyArb` は odd id (1, 3, ..., 201) を生成し、その中に IMMUTABLE_PROPERTIES (11) が含まれる。`data` は `fc.uint8Array({ minLength: 0, maxLength: 20 })` で任意バイトを生成する。

```typescript
const oddPropertyArb = fc
  .record({
    id: fc.bigInt({ min: 0n, max: 100n }).map((n) => n * 2n + 1n),
    data: fc.uint8Array({ minLength: 0, maxLength: 20 }),
  })
  .map(({ id, data }) => ({ id, data }));
```

id が 11 (IMMUTABLE_PROPERTIES) のとき、`data` がネストした IMMUTABLE_PROPERTIES キー (byte 11) を含むと、`decodeProperties` (`src/properties.ts:671` 付近) が次の MUST 違反を検出して throw する。

```
MalformedTrackError: immutable properties must not recursively contain another immutable properties key
```

検出されたカウンターexample: `{ id: 11n, data: Uint8Array.from([11]) }`。

同一の `oddPropertyArb` / `propertyArb` / `trackPropertiesArb` 定義が複数ファイルに重複している。

- `src/message/fetch.prop.ts:112`
- `src/message/publish.prop.ts:116` 付近
- `src/message/subscribe.prop.ts:117` 付近
- `src/message/session.prop.ts:241` 付近
- `src/properties.prop.ts:250` 付近

いずれも properties を `decodeProperties` 経由でラウンドトリップするため、同じ flake を持ちうる。

## 仕様根拠

draft-ietf-moq-transport-18 §2.4.2 / §12.x: IMMUTABLE_PROPERTIES (Type 0x0B) の Value 内に再び IMMUTABLE_PROPERTIES を含めることは禁止されており、違反した Track は malformed track として扱われる。`decodeProperties` の検出は正しい。よって修正すべきはテストジェネレータ側であり、production コードではない。

## 設計方針

`oddPropertyArb` が IMMUTABLE_PROPERTIES (11) を生成しないよう制約する。`evenPropertyArb` が `DEFAULT_PUBLISHER_PRIORITY` 等を `filter` で除外しているのと同じ方式に揃える。

```typescript
const oddPropertyArb = fc
  .record({
    id: fc
      .bigInt({ min: 0n, max: 100n })
      .map((n) => n * 2n + 1n)
      .filter((id) => id !== MOQTPropertyId.IMMUTABLE_PROPERTIES),
    data: fc.uint8Array({ minLength: 0, maxLength: 20 }),
  })
  .map(({ id, data }) => ({ id, data }));
```

IMMUTABLE_PROPERTIES のラウンドトリップを別途検証したい場合は、ネストに再帰 IMMUTABLE_PROPERTIES を含まない有効な data を生成する専用の arbitrary を用意する。

重複定義が複数ファイルにあるため、共通の arbitrary を 1 箇所 (例: テスト用ヘルパー) に集約して全ファイルから参照する案も検討する。最低限、全 5 ファイルの `oddPropertyArb` を同様に修正すること。

## 完了条件

- `oddPropertyArb` が IMMUTABLE_PROPERTIES (11) を生成しない (または有効な data のみ生成する) よう修正されている
- 重複する全ファイルの `oddPropertyArb` が修正されている (横断確認の結果を記載する)
- `decodeProperties` の再帰 IMMUTABLE_PROPERTIES 検出自体の単体テストは別途維持する (PBT で網羅できない MUST 違反検出は example テストで担保する)
- 同一 seed (`1516739457`) で fail しないことを確認する
- 既存の全テストが PASS する
- `CHANGES.md` の `### misc` に `[FIX]` エントリを追記する (テスト専用の修正のため)

## 解決方法

設計方針通り、`oddPropertyArb` の id 生成に `.filter((id) => id !== MOQTPropertyId.IMMUTABLE_PROPERTIES)` を追加して IMMUTABLE_PROPERTIES (0x0b = 11) を除外した。

### 修正したファイル

`n * 2n + 1n` で odd id を生成し IMMUTABLE_PROPERTIES を除外していなかった 4 ファイルを修正した。

- `src/message/fetch.prop.ts`
- `src/message/publish.prop.ts`
- `src/message/subscribe.prop.ts`
- `src/message/session.prop.ts`

各ファイルで `MOQTPropertyId` を `../properties` から import し、`evenPropertyArb` の除外方式に倣って filter を追加した。`src/properties.prop.ts` は既に IMMUTABLE_PROPERTIES を除外済みのため修正対象外。リポジトリ全体の `*.prop.ts` を確認し、他に同型の flake-prone ジェネレータが無いことを確認した。

### 検証

- 文書化された flaky seed (`1516739457`) を含め、修正後はテストが安定して PASS することを複数回の実行で確認した。
- odd id 全域 [1, 201] のうち IMMUTABLE_PROPERTIES (11) のみがラウンドトリップを破綻させる id であることを確認した (他の odd id は worst-case data でも `MalformedTrackError` を投げない)。よって 11 の除外で必要十分。
- IMMUTABLE_PROPERTIES の正常 roundtrip は `src/properties.prop.ts` (有効な nested data を生成) が、再帰検出の MUST 違反は `src/properties.test.ts` の専用テストが維持しており、カバレッジ損失はない。

### CHANGES.md

テスト専用の修正のため `### misc` に `[FIX]` エントリを追記した。

### スコープ外として記録する事項

`oddPropertyArb` / `evenPropertyArb` / `propertyArb` が 5 ファイルにほぼ同一コピーで重複しており、今回も 4 箇所に同じ filter を貼る形になった。共通ヘルパーへの集約は DRY 改善になるが、`properties.prop.ts` のみ id 範囲が異なる (0xff vs 100n) など挙動差があり、本 issue のスコープ (flaky 解消) 外のため見送った。

## 解決方法

(対応時に記載する)
