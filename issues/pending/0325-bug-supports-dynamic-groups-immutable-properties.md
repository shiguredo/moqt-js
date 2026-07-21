# supportsDynamicGroups が Immutable Properties 内の DYNAMIC_GROUPS を誤検出する

- Priority: High
- Created: 2026-06-30
- Completed:
- Model: Kimi Code CLI
- Branch: feature/fix-supports-dynamic-groups-immutable-properties
- Polished:

## 目的

`supportsDynamicGroups()` が `decodeProperties()` の出力（`Property[]`）を正しく解釈できず、Immutable Properties 内に DYNAMIC_GROUPS=1 が含まれている Track を誤って「DYNAMIC_GROUPS 未対応」と判定する。これにより `createMediaSubscriber.requestKeyframe()` が拒否され、キーフレーム要求が送出できなくなる。

## 優先度根拠

- draft-18 §12.7 に基づき、mutable list と Immutable Properties の両方を検索する必要がある MUST 相当の要件。
- 実運用でキーフレーム要求が誤って拒否される機能障害となる。
- 既存テストが誤ったデータ形式で `supportsDynamicGroups()` を検証しており、実際のワイヤー形式ではバグが潜んでいる。

## 現状

`src/properties.ts` の `decodeProperties()` は奇数 ID プロパティの `data` に **length プレフィックス以降の body のみ** を格納する（`data.slice(offset + deltaIdLen + lengthLen, ...)`）。

一方、`supportsDynamicGroups()` はその `property.data` を `decodeImmutableProperties()` に渡す。`decodeImmutableProperties()` は **ID + length + body** を想定して先頭から varint ID を読むため、`property.data`（body のみ）の先頭バイトを ID と誤認識する。

### 再現

```ts
const encoded = encodeImmutableProperties({
  extensions: [{ id: TrackPropertyId.DYNAMIC_GROUPS, value: 1n }],
});
// encoded = [0x0B, 0x02, 0x30, 0x01] (ID + length + body)

const properties = decodeProperties(encoded);
// properties = [{ id: 0x0Bn, data: [0x30, 0x01] }] (body のみ)

supportsDynamicGroups(properties); // => false (本来は true)
```

`src/properties.test.ts:445` でも `encoded`（ID + length + body）をそのまま `Property.data` に入れてテストしており、実際の `decodeProperties()` 出力とは異なる。

## 設計方針

- `supportsDynamicGroups()` が Immutable Properties の中身を正しく解析できるようにする。
- 既存の `decodeImmutableProperties()` の入出力インターフェースを変更するか、新たに body-only を受け取る内部ヘルパーを追加するかを検討する。
- テストを実際の `decodeProperties()` 経由の `Property[]` を使う形に修正する。

## 完了条件

- `supportsDynamicGroups(decodeProperties(encodeImmutableProperties({ extensions: [{ id: TrackPropertyId.DYNAMIC_GROUPS, value: 1n }] })))` が `true` を返すこと。
- mutable list と Immutable Properties の両方に DYNAMIC_GROUPS=1 がある場合に `true` を返すこと。
- 既存の `requestKeyframe()` 経路で、Immutable Properties 内 DYNAMIC_GROUPS=1 の Track に対してキーフレーム要求が送出されること。
- `src/properties.test.ts` のテストデータ形式が実際のワイヤー形式と一致すること。

## 解決方法

1. `src/properties.ts` の `supportsDynamicGroups()` を修正し、`property.data`（body のみ）を正しく解析する。
2. `src/properties.test.ts` の `supportsDynamicGroups` 関連テストを実際の `decodeProperties()` 出力を使う形に修正する。
3. 必要に応じて `decodeImmutableProperties()` のドキュメント/実装を整理し、呼び出し元との整合性を保つ。

## 該当箇所一覧

| ファイル                 | 変更内容                                                     |
| ------------------------ | ------------------------------------------------------------ |
| `src/properties.ts`      | `supportsDynamicGroups()` の Immutable Properties 解析を修正 |
| `src/properties.test.ts` | テストデータ形式を実際のワイヤー形式に修正                   |
