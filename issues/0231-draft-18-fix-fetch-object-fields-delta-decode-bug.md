# Fetch Object Fields のデコードで Group ID Delta と Object ID Delta が絶対値として扱われるバグ

- Priority: High
- Created: 2026-06-02
- Model: deepseek-v4-pro
- Branch: {Git-Flow のブランチ名}
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-transport-18 §11.4.4 で規定されている Fetch Object Fields の delta encoding デコードにバグがあり、非先頭オブジェクトの Group ID と Object ID が誤って計算される問題を修正する。

## 優先度根拠

Fetch で複数オブジェクトを受信する場合に誤った Object ID / Group ID が計算され、アプリケーションが不整合なデータを受け取る致命的なバグであるため High。

## 現状

`src/dataStream.ts` の `decodeFetchObjectFields` 関数:

- 行 1135-1137: `GROUP_ID_PRESENT` フラグがセットされた場合、デコードした値を **delta ではなく絶対 Group ID としてそのまま使用** している
- 行 1177-1180: `OBJECT_ID_PRESENT` フラグがセットされた非先頭オブジェクトで、**絶対 Object ID として直接使用** している

## 一次資料の引用

draft-ietf-moq-transport-18 §11.4.4 (Fetch Header):

> Group ID = Delta Group ID + Prior Group ID

> When the Group ID Delta field is not present, the Object ID is the prior
> Object's ID plus the Object ID Delta if present.

## 該当コード

`src/dataStream.ts:1133-1137`:
```typescript
if (flags & FetchSerializationFlags.GROUP_ID_PRESENT) {
  const [gid, gidConsumed] = decodeVarint(data, offset + totalConsumed);
  groupId = gid; // 誤り: delta から絶対値を計算すべき
```

`src/dataStream.ts:1174-1180`:
```typescript
if (flags & FetchSerializationFlags.OBJECT_ID_PRESENT) {
  const [oid, oidConsumed] = decodeVarint(data, offset + totalConsumed);
  objectId = oid; // 誤り: prior + oid とすべき (Group 不変時)
```

## 設計方針

1. `GROUP_ID_PRESENT` 時: `groupId = priorContext.groupId + decodedDelta`
2. `OBJECT_ID_PRESENT` かつ Group 不変時: `objectId = priorContext.objectId + decodedDelta`
3. テストケースを追加して delta encoding の正しさを検証する
   - 最初のオブジェクト: delta = 絶対値（基準点）
   - 後続オブジェクト: 正しい delta 計算で絶対値が復元できること

## 完了条件

- `decodeFetchObjectFields` が Group ID と Object ID を delta encoding として正しく計算する
- Fetch Object Fields のエンコード (`encodeFetchObjectFields`) が delta encoding で正しくエンコードする
- テストが追加され既存テストが通ること
- `vp run test` 全パス
- `vp run build` 成功
