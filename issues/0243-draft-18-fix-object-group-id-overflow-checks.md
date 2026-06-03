# Subgroup/Fetch Object ID および Group ID のオーバーフローチェックを追加する

- Priority: Medium
- Created: 2026-06-03
- Model: deepseek-v4-pro
- Branch: feature/fix-id-overflow-checks
- Polished: 2026-06-03

## 目的

draft-ietf-moq-transport-18 で MUST 要件として定義されている Object ID および Group ID のオーバーフローチェックが欠落しているため、全計算パスに追加する。

- Section 11.4.2 (Subgroup):

  > "If the resulting Object ID would be greater than 2^64 - 1, the
  > endpoint MUST close the session with a PROTOCOL_VIOLATION."

- Section 11.4.4.1 (Fetch, Table 9):
  > "If the computed Group ID would be less than 0 or greater than
  > 2^64-1, the Subscriber MUST close the Session with error
  > 'PROTOCOL_VIOLATION'."
  >
  > "If the computed Object ID would be greater than 2^64-1, the
  > Subscriber MUST close the Session with error 'PROTOCOL_VIOLATION'."

## 優先度根拠

MUST 要件の欠落。64 ビット整数の境界で誤動作する可能性があるが、実際のトラフィックで 2^64-1 を超える値が発生するケースは稀なため Medium とする。

## 現状

### Subgroup データストリーム

`src/session/stream.ts` の `processSubgroupObjects`:

```ts
// line 135: 先頭オブジェクトの Object ID（絶対値）
objectId = fields.objectIdDelta; // オーバーフローチェックなし

// line 137: 2 番目以降の Object ID
objectId = currentPreviousObjectId + fields.objectIdDelta + 1n; // チェックなし
```

### Fetch データストリーム

`src/dataStream.ts` `decodeFetchObjectFields`:

```ts
// line 1264: 先頭オブジェクトの Group ID（絶対値）
groupId = delta; // チェックなし

// line 1266: 2 番目以降の Group ID（Ascending）
groupId = context.groupId + delta + 1n; // チェックなし

// line 1273: Group ID 不変時（context 継承）
groupId = context.groupId; // overflow しないのでチェック不要

// line 1317: 先頭または Group 変化時の Object ID（絶対値）
objectId = delta; // チェックなし

// line 1324: Object ID Delta なし（+1）
objectId = context.objectId + 1n; // チェックなし
```

上記のうち `stream.ts:135, stream.ts:137, dataStream.ts:1264, dataStream.ts:1266, dataStream.ts:1317, dataStream.ts:1324, dataStream.ts:1315` の最低 7 箇所に overflow チェックが必要。

### 定数

コードベース全体で `2n ** 64n - 1n` 相当の定数は未定義。`src/message/parameter.ts` に `MAX_TRACK_NAMESPACE_SIZE` 等の命名例がある。これに倣い `MAX_OBJECT_ID` 等の定数を定義する。

## 設計方針

1. `2n ** 64n - 1n` を表す定数を共用で定義する。置き場所は `src/varint.ts` または新規の定数ファイル
2. 上記 7 箇所すべてに overflow チェックを追加する
3. 計算結果が `2n ** 64n` 以上の場合、`ProtocolViolationError` を throw する
4. Group ID の < 0 チェックは Descending Group Order (0241) 実装時に追加する。本 issue のスコープからは外す（Ascending では Group ID が負になることはない）
5. Subgroup ID (`dataStream.ts:1293` の `context.subgroupId + 1n`) の overflow チェックは仕様上の明示的な MUST 要件がないため、本 issue のスコープからは外す

### 他 issue との関係

- 0241 (Descending Group Order): `decodeFetchObjectFields` を修正する。0241 側でも Group ID の範囲検証が完了条件に含まれているため、Fetch decode の Group ID オーバーフローチェックは 0241 で合わせて実装してもよい（Subgroup stream 側は本 issue 固有）
- 0242 (DATAGRAM フラグ): 同一関数だが修正箇所が異なる

## 完了条件

- Subgroup stream の Object ID 計算（先頭・後続の両方）で overflow が検出されること
- Fetch decode の Group ID / Object ID 計算（絶対値・相対値の全パス）で overflow が検出されること
- 各計算箇所に RFC セクション番号をコメントで記載すること

### 必要なテストケース

1. Subgroup: `currentPreviousObjectId = 2^64-1` で `delta = 0` → `objectId` = `2^64` で overflow → `ProtocolViolationError`
2. Subgroup: `fields.objectIdDelta = 2^64` で先頭オブジェクト → overflow
3. Fetch Group ID: `context.groupId = 2^64-1` で `delta = 1` → overflow
4. Fetch Group ID: 先頭オブジェクトで `delta = 2^64` → overflow
5. Fetch Object ID: `context.objectId = 2^64-1` で `+1` → overflow
6. Fetch Object ID: 先頭オブジェクトで `delta = 2^64` → overflow
7. 境界値: `2^64-1` ちょうどの正常値が overflow 扱いされないこと
