# Fetch Object の DATAGRAM ビット (0x40) 対応を実装する

- Priority: Medium
- Created: 2026-06-03
- Model: deepseek-v4-pro
- Branch: feature/add-fetch-datagram-flag-handling
- Polished: 2026-06-03

## 目的

draft-ietf-moq-transport-18 Section 11.4.4.1 で定義されている Fetch Object Fields の DATAGRAM フラグ (0x40) が未対応であるため、実装する。

> "When 0x40 is set, it SHOULD set the two least significant bits to
>  zero and the subscriber MUST ignore the bits."

現在の `decodeFetchObjectFields` は Serialization Flags の DATAGRAM ビット (0x40) がセットされている場合でも、下位 2 ビットの Subgroup ID encoding を無視せずに処理してしまう。DATAGRAM オブジェクトには Subgroup ID が存在しないため、下位 2 ビットを無視する必要がある。

## 優先度根拠

MUST 要件。Datagram forwarding preference の Fetch object で Subgroup ID が誤って計算される可能性があるが、実際にこのフラグを使用するワイヤーフォーマットの組み合わせは限定的なため Medium とする。

## 現状

`src/dataStream.ts` `decodeFetchObjectFields` (line 1278-1303) 内の Subgroup ID encoding switch 文は、DATAGRAM フラグの有無に関わらず下位 2 ビットを評価している:

```ts
const subgroupEncoding = flags & FetchSerializationFlags.SUBGROUP_MASK;
switch (subgroupEncoding) {
  case FetchSerializationFlags.SUBGROUP_ZERO: ...
  case FetchSerializationFlags.SUBGROUP_SAME: ...
  case FetchSerializationFlags.SUBGROUP_PLUS_ONE: ...
  case FetchSerializationFlags.SUBGROUP_PRESENT: ...
}
```

## 設計方針

1. `decodeFetchObjectFields` で DATAGRAM ビット (0x40) がセットされている場合、Subgroup ID の下位 2 ビットを無視し、`subgroupId` を `0n` または未定義に設定する
2. `encodeFetchObjectFields` でも DATAGRAM ビット設定時に下位 2 ビットを 0 にする

## 完了条件

- `decodeFetchObjectFields` が DATAGRAM フラグ (0x40) セット時に下位 2 ビットを無視すること
- Subgroup ID が 0n として解決されること
- 関連するテストが追加されていること

## 解決方法

1. `decodeFetchObjectFields` で DATAGRAM ビットのチェックを Subgroup ID encoding より先に行う
2. DATAGRAM ビットがセットされている場合、`subgroupId = 0n` とし、下位 2 ビットの評価をスキップする
3. 同様に `encodeFetchObjectFields` / `createFetchObjectFlags` でも DATAGRAM 時に下位 2 ビットを 0 に設定する
