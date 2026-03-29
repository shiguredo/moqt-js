# DatagramType 定数 0x2C/0x2D の命名を修正する

Created: 2026-03-29
Model: Opus 4.6

## 概要

DatagramType 定数の 0x2C/0x2D の命名が Object ID の有無について誤解を招く名前になっている。

## RFC 根拠

draft-ietf-moq-transport-17 Section 10.3.1 Object Datagram:

OBJECT_DATAGRAM の Type フィールドの有効な値:

```
Type (i) = 0x00..0x0F / 0x20..0x21 / 0x24..0x25 /
           0x28..0x29 / 0x2C..0x2D,
```

> The ZERO_OBJECT_ID bit (0x04) indicates when the Object ID field is present. When set to 1, the Object ID field is omitted and the Object ID is 1. When set to 0, the Object ID field is present.

0x2C (= 0x20 + 0x08 + 0x04) と 0x2D (= 0x20 + 0x08 + 0x04 + 0x01) は STATUS (0x20) + DEFAULT_PRIORITY (0x08) + ZERO_OBJECT_ID (0x04) の組み合わせであり、Object ID フィールドは存在しない。しかし定数名に `OBJ` が含まれており Object ID ありと誤解させる。

## 該当箇所

- `src/dataStream.ts` 行 524-527

```typescript
STATUS_OBJ_NO_PRI_2: 0x2c,
STATUS_OBJ_EXT_NO_PRI_2: 0x2d,
```

## 修正方針

定数名を以下のように修正する:

- `STATUS_OBJ_NO_PRI_2` → `STATUS_NO_OBJ_NO_PRI`
- `STATUS_OBJ_EXT_NO_PRI_2` → `STATUS_NO_OBJ_EXT_NO_PRI`

注: issue 0056 の datagramHasObjectId 修正とあわせて対応する。
