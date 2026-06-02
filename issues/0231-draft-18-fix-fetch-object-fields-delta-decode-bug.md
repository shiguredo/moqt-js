# Fetch Object Fields のデコードで Group ID Delta と Object ID Delta が絶対値として扱われるバグを修正する

- Priority: High
- Created: 2026-06-02
- Model: deepseek-v4-pro
- Branch: feature/fix-fetch-delta-encoding-decode
- Polished: 2026-06-02

## 目的

draft-ietf-moq-transport-18 §11.4.4.1 で規定されている Fetch Object Fields の delta encoding デコードに 2 つのバグがあり、非先頭オブジェクトで誤った Group ID / Object ID が計算される問題を修正する。

## 優先度根拠

FETCH で複数オブジェクトを受信する場合に誤った ID が計算され、アプリケーションが不整合なデータを受け取る。データ整合性に直接影響する致命的なバグのため High。

## 一次資料の引用

draft-ietf-moq-transport-18 §11.4.4.1 (Fetch Serialization Flags, Table 9):

Group ID Delta (0x08):

> If the Group Order is Ascending (default), the Group ID is the prior
> Object's Group ID plus the Group ID Delta + 1.

Object ID Delta (0x02):

> When the Group ID Delta field is not present, the Object ID is the
> prior Object's ID plus the Object ID Delta if present.

## バグ 1: Group ID Delta の誤計算

### 該当コード

`src/dataStream.ts:1133-1137`:

```typescript
if (flags & FetchSerializationFlags.GROUP_ID_PRESENT) {
  const [gid, gidConsumed] = decodeVarint(data, offset + totalConsumed);
  groupId = gid; // 誤り: delta を絶対値として使用
```

### 仕様との差異

非先頭オブジェクトで `GROUP_ID_PRESENT` がセットされた場合、フィールド値は delta (差分) であり、正しい Group ID は `prior.groupId + delta + 1n` (Ascending 時)。

例: prior.groupId=10000, delta=5 → 現在の計算:5, 正しい計算:10006

**注意**: 先頭オブジェクト (`isFirst=true`) では delta が絶対値と等価であるため、現行コードが正しい。条件分岐で先頭オブジェクトの場合は絶対値として扱う必要がある。

## バグ 2: Object ID Delta の誤計算 (Group 不変時)

### 該当コード

`src/dataStream.ts:1174-1180`:

```typescript
if (flags & FetchSerializationFlags.OBJECT_ID_PRESENT) {
  const [oid, oidConsumed] = decodeVarint(data, offset + totalConsumed);
  objectId = oid; // 誤り: delta を絶対値として使用 (Group 不変時)
```

### 仕様との差異

Group が変化しない (`!GROUP_ID_PRESENT`) 場合で `OBJECT_ID_PRESENT` がセットされているとき、正しい Object ID は `prior.objectId + delta`。

**注意**: Group が変化する (`GROUP_ID_PRESENT`) 場合は、Object ID Delta は新 Group 内の絶対値であり、現行コードが正しい。

## バグ 3: encodeFetchObjectFields も同様の誤り

`src/dataStream.ts:989-993`、`src/dataStream.ts:1009-1012`:

encode 側も同様に delta 計算を行わず絶対値をエンコードしている。このため encode→decode ラウンドトリップが偶然一致し、バグが既存テストで検出されなかった。

## 設計方針

### decodeFetchObjectFields の修正

```typescript
// Group ID Delta
if (flags & FetchSerializationFlags.GROUP_ID_PRESENT) {
  const [delta, consumed] = decodeVarint(data, offset + totalConsumed);
  if (isFirst || context === null) {
    groupId = delta; // 先頭オブジェクト: delta は絶対値
  } else {
    groupId = context.groupId + delta + 1n; // Ascending
  }
  totalConsumed += consumed;
}

// Object ID Delta
if (flags & FetchSerializationFlags.OBJECT_ID_PRESENT) {
  const [delta, consumed] = decodeVarint(data, offset + totalConsumed);
  if (!(flags & FetchSerializationFlags.GROUP_ID_PRESENT) && !isFirst && context !== null) {
    objectId = context.objectId + delta; // Group 不変時: prior + delta
  } else {
    objectId = delta; // 先頭 または Group 変化時: 絶対値
  }
  totalConsumed += consumed;
}
```

### encodeFetchObjectFields の修正

encode 側でも同様に delta 計算を行う:

- `GROUP_ID_PRESENT`: `delta = currentGroupId - priorGroupId - 1` (先頭オブジェクトの場合は delta = currentGroupId)
- `OBJECT_ID_PRESENT` (Group 不変時): `delta = currentObjectId - priorObjectId`

## テスト戦略

### 単体テスト (dataStream.test.ts)

既存テストは全て先頭オブジェクト + delta=0 の偶然一致でパスしている。以下を追加する:

1. **非先頭オブジェクトで Group ID が変化するケース**: `GROUP_ID_PRESENT` セット、delta 非ゼロ、Ascending。正しい Group ID = prior + delta + 1 が計算されること
2. **非先頭オブジェクトで Object ID が変化するケース (Group 不変)**: `OBJECT_ID_PRESENT` セット、`!GROUP_ID_PRESENT`、delta 非ゼロ。正しい Object ID = prior + delta が計算されること
3. **encode→decode ラウンドトリップ**: 複数オブジェクトの encode + decode で ID が正しく復元されること

## 影響範囲

- `src/dataStream.ts`: `decodeFetchObjectFields` の Group ID/Object ID 計算を修正
- `src/dataStream.ts`: `encodeFetchObjectFields` の delta エンコードを修正
- `src/dataStream.test.ts`: 非先頭オブジェクトの delta encoding テストを追加

## 後方互換

- ワイヤーフォーマット自体は変わらない（デコードロジックの修正のみ）
- 既存の先頭オブジェクトの処理は変更なし
- 非先頭オブジェクトの Group ID/Object ID が正しい値に変わる（バグ修正）

## 完了条件

- `decodeFetchObjectFields` が Group ID Delta を正しく計算する (prior + delta + 1)
- `decodeFetchObjectFields` が Object ID Delta を正しく計算する (Group 不変時: prior + delta)
- `encodeFetchObjectFields` が適切な delta 値を計算する
- 非先頭オブジェクトで delta 非ゼロのテストが追加されている
- roundtrip テストが追加されている
- `vp run test` 全パス
- `vp run build` 成功
