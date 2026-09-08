# FETCH の DATAGRAM フラグで Subgroup ID を読み飛ばさない

- Created: 2026-09-08
- Completed: YYYY-MM-DD
- Branch: feature/fix-fetch-datagram-subgroup-id
- Polished: YYYY-MM-DD

## 目的

draft-ietf-moq-transport-20 §11.4.4.1 の MUST に適合させる。DATAGRAM ビット (0x40) が立つ Object は Subgroup ID を持たず、下位 2 ビットを無視しなければならない。現状は下位 2 ビットが SUBGROUP_PRESENT のとき varint を 1 個余分に消費し、後続フィールドがずれる。

## 現状

- `src/dataStream.ts` の `decodeFetchSubgroupId` は `isDatagram && (flags & SUBGROUP_MASK) === SUBGROUP_PRESENT` のとき varint を読み飛ばす。
- 仕様 §11.4.4.1:「When encoding an Object with a Forwarding Preference of "Datagram" ... the object has no Subgroup ID. The publisher MUST SET bit 0x40 to '1'. When 0x40 is set, it SHOULD set the two least significant bits to zero and the subscriber MUST ignore the bits.」
- エンコーダ側 `encodeFetchObjectFields` は DATAGRAM 時に Subgroup ID フィールドを出さないため、自実装同士でも非対称。
- `src/dataStream.fetch.test.ts` の「DATAGRAM+SUBGROUP_PRESENT (0x43) で Subgroup ID vi64 を読み飛ばす」テストが誤った挙動を固定している。

## 設計方針

1. DATAGRAM ビットが立つ場合は下位 2 ビットの値に関わらず Subgroup ID varint を消費せず、`subgroupId = 0n` / `isDatagram = true` を返す。
2. 上記テストを仕様準拠（Subgroup ID フィールドが存在しない前提で後続フィールドが読める）に修正し、0x43 でも Group / Object ID / Priority が正しく復元されることを検証する。
3. 0x40 と SUBGROUP_PRESENT の同時指定が不正でないこと（MUST ignore）をコメントに残す。

## 完了条件

- DATAGRAM ビット付き Fetch Object で Subgroup ID フィールドを消費しないこと。
- 0x43 のワイヤで Group ID / Object ID / Priority / payload length が正しくデコードされること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 関連

- draft-ietf-moq-transport-20 §11.4.4 / §11.4.4.1
- `decodeFetchSubgroupId` / `encodeFetchObjectFields`
- `FetchSerializationFlags`
