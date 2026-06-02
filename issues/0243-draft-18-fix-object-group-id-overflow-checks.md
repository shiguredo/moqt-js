# Subgroup/Fetch Object ID および Group ID のオーバーフローチェックを追加する

- Priority: Medium
- Created: 2026-06-03
- Model: deepseek-v4-pro
- Branch: feature/add-id-overflow-checks
- Polished: 2026-06-03

## 目的

draft-ietf-moq-transport-18 で MUST 要件として定義されている Object ID および Group ID のオーバーフローチェックが欠落しているため追加する。

Section 11.4.2 (Subgroup):
> "If the resulting Object ID would be greater than 2^64 - 1, the
>  endpoint MUST close the session with a PROTOCOL_VIOLATION."

Section 11.4.4.1 (Fetch):
> "If the computed Group ID would be less than 0 or greater than
>  2^64-1, the Subscriber MUST close the Session with error
>  'PROTOCOL_VIOLATION'."
>
> "If the computed Object ID would be greater than 2^64-1, the
>  Subscriber MUST close the Session with error 'PROTOCOL_VIOLATION'."

## 優先度根拠

MUST 要件の欠落であり、64 ビット整数の境界で誤動作する可能性があるが、実際に 2^64-1 の値が使用されるケースは稀なため Medium とする。

## 現状

以下の箇所で Object ID / Group ID のオーバーフローチェックが欠落している:

1. `src/session/stream.ts:137` - Subgroup stream の Object ID 計算:
   ```ts
   objectId = currentPreviousObjectId + fields.objectIdDelta + 1n;
   ```

2. `src/dataStream.ts:1266` - Fetch decode の Group ID 計算:
   ```ts
   groupId = context.groupId + delta + 1n;
   ```

3. `src/dataStream.ts:1315` - Fetch decode の Object ID 計算:
   ```ts
   objectId = context.objectId + delta;
   ```

## 設計方針

1. 各計算後に結果が `2n ** 64n - 1n` を超えていないか検証する
2. Group ID が 0 未満になっていないかも検証する（Descending 時の対策）
3. 検証違反時は `ProtocolViolationError` を throw し、上位でセッションを閉じる

## 完了条件

- Subgroup stream の Object ID 計算でオーバーフローが検出されること
- Fetch decode の Group ID / Object ID 計算でオーバーフローが検出されること
- 関連するテストが追加されていること

## 解決方法

1. `src/session/stream.ts` の Object ID 計算後に検証を追加する
2. `src/dataStream.ts` `decodeFetchObjectFields` の Group ID / Object ID 計算後に検証を追加する
3. エッジケースのテストを追加する
