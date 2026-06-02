# OBJECT_DELIVERY_TIMEOUT の命名を DELIVERY_TIMEOUT から修正する

- Priority: Low
- Created: 2026-06-03
- Model: deepseek-v4-pro
- Branch: feature/rename-object-delivery-timeout
- Polished: 2026-06-03

## 目的

draft-ietf-moq-transport-18 の正式名称に合わせて、内部の定数名を修正する。

- Message Parameter: `Section 10.2.4` — 名称は `OBJECT_DELIVERY_TIMEOUT`
- Track Property: `Section 12.2` — 名称は `OBJECT_DELIVERY_TIMEOUT`

現在のコードでは両方が `DELIVERY_TIMEOUT` と命名されており、SUBGROUP_DELIVERY_TIMEOUT との区別や仕様参照時の混乱を招く。

なお、Stream Reset Error Code の `DELIVERY_TIMEOUT` (`src/error.ts:112`) は `Section 15.10.4` に従っているため正しい。修正不要。

## 優先度根拠

仕様上の正確な名称に合わせる命名修正であり、機能的なバグではないため Low とする。

## 現状

1. `src/message/types.ts:121`:
   ```ts
   DELIVERY_TIMEOUT: 0x02,
   ```
   `MessageParameterType` 内で `OBJECT_DELIVERY_TIMEOUT` ではなく `DELIVERY_TIMEOUT` と命名されている。

2. `src/properties.ts:59`:
   ```ts
   DELIVERY_TIMEOUT: 0x02n,
   ```
   `TrackPropertyId` 内で `OBJECT_DELIVERY_TIMEOUT` ではなく `DELIVERY_TIMEOUT` と命名されている。

3. `src/session/params.ts:89` など、上記定数を参照する全箇所も合わせて修正が必要。

## 設計方針

1. `MessageParameterType.DELIVERY_TIMEOUT` → `MessageParameterType.OBJECT_DELIVERY_TIMEOUT`
2. `TrackPropertyId.DELIVERY_TIMEOUT` → `TrackPropertyId.OBJECT_DELIVERY_TIMEOUT`
3. すべての参照箇所を修正する
4. `src/error.ts` の `DataStreamErrorCode.DELIVERY_TIMEOUT` はそのまま（正しい）

## 完了条件

- 定数名が仕様に準拠した名称に修正されていること
- すべてのテストが通過すること

## 解決方法

1. `src/message/types.ts` の定数名を修正
2. `src/properties.ts` の定数名を修正
3. 参照箇所を grep で特定し、すべて修正する
4. テストが通過することを確認する
