# datagramHasObjectId が 0x2C/0x2D の ZERO_OBJECT_ID を誤判定している

Created: 2026-03-29
Model: Opus 4.6

## 概要

`datagramHasObjectId` 関数が 0x2C/0x2D タイプのデータグラムで ZERO_OBJECT_ID ビット (0x04) を考慮しておらず、Object ID フィールドの有無を誤判定している。

## RFC 根拠

draft-ietf-moq-transport-17 Section 10.3.1 Object Datagram:

OBJECT_DATAGRAM の Type フィールドの有効な値:

```
Type (i) = 0x00..0x0F / 0x20..0x21 / 0x24..0x25 /
           0x28..0x29 / 0x2C..0x2D,
```

ZERO_OBJECT_ID ビットについて:

> The ZERO_OBJECT_ID bit (0x04) indicates when the Object ID field is present. When set to 1, the Object ID field is omitted and the Object ID is 1. When set to 0, the Object ID field is present.

0x2C (= 0x20 + 0x08 + 0x04) と 0x2D (= 0x20 + 0x08 + 0x04 + 0x01) は ZERO_OBJECT_ID ビットが立っているため Object ID フィールドは存在しない。しかし現在の実装では 0x24/0x25 のみ Object ID なしと判定しており、0x2C/0x2D が漏れている。

## 該当箇所

- `src/dataStream.ts` 行 553-561

```typescript
function datagramHasObjectId(type: number): boolean {
  if (type >= 0x20) {
    return type !== 0x24 && type !== 0x25; // 0x2C, 0x2D が漏れている
  }
  return (type & 0x04) === 0;
}
```

## 修正方針

全タイプで `(type & 0x04) === 0` を使うように統一する。あわせて以下も修正する:

- 行 484-485: コメントテーブルの Object ID カラムが 0x2C/0x2D で `Yes` になっているが `No` が正しい
- 行 524-527: DatagramType 定数名 `STATUS_OBJ_NO_PRI_2` / `STATUS_OBJ_EXT_NO_PRI_2` を `STATUS_NO_OBJ_NO_PRI` / `STATUS_NO_OBJ_EXT_NO_PRI` に修正する

## 解決方法

Completed: 2026-03-29

- `datagramHasObjectId()` を全タイプで `(type & 0x04) === 0` を使うように統一した
- コメントテーブルの 0x2C/0x2D の Object ID カラムを `No` に修正した
- DatagramType 定数名を `STATUS_NO_OBJ_NO_PRI` / `STATUS_NO_OBJ_EXT_NO_PRI` に修正した
- 0x2C/0x2D タイプの roundtrip テストを追加した
