# SUBSCRIBE_NAMESPACE の Length フィールドが可変長整数でエンコードされている

Created: 2026-04-29
Model: Opus 4.7

## 概要

`src/session.ts` の `subscribeNamespace()` が SUBSCRIBE_NAMESPACE を送信する際、Control Message の Length フィールドを 16-bit big-endian ではなく可変長整数 (varint) でエンコードしている。draft-ietf-moq-transport-17 Section 9.20 では Length は固定 16-bit と定義されているため、仕様違反であり相互運用性が壊れている。

## 根拠

draft-ietf-moq-transport-17 Section 9.20 (`refs/moq/draft-ietf-moq-transport-17.txt:4289-4298`):

```
SUBSCRIBE_NAMESPACE Message {
  Type (vi64) = 0x11,
  Length (16),
  Request ID (vi64),
  Required Request ID Delta (vi64),
  Track Namespace Prefix (..),
  Subscribe Options (vi64),
  Number of Parameters (vi64),
  Parameters (..) ...
}
```

`Length (16)` は 16-bit big-endian 固定。実際 `ControlStreamWriter.encode()` (`src/controlStream.ts:121-139`) はこれを正しく実装している。受信側 `ControlStreamReader.processMessages()` (`src/controlStream.ts:89`) も 16-bit big-endian でデコードする。

## 該当コード

`src/session.ts:1542-1545`:

```typescript
const typeAndLength = new Uint8Array([
  ...encodeVarint(MessageType.SUBSCRIBE_NAMESPACE),
  ...encodeVarint(payload.length),
]);
```

第 2 引数の `encodeVarint(payload.length)` は Length を varint でエンコードしてしまっている。

## 影響

- payload.length が 0-63 の場合、varint は 1 バイトを生成。受信側は 16-bit と解釈するため、続く 1 バイト (Request ID 先頭) を Length 下位バイトとして読み込み、メッセージ全体が完全に misparse される。
- payload.length が 64-16383 の場合、varint は 2 バイトを生成するがビット表現が異なる (上位 2 ビットが `01`)。Length を 16-bit big-endian で読むと約 16384 加算された巨大な値になり、buffer 不足で永久に待機する。

いずれにせよ、仕様準拠の peer (relay 含む) に対して SUBSCRIBE_NAMESPACE を発行すると即時に PROTOCOL_VIOLATION で session が閉じられる。

## 既存テストで取りこぼされた理由

`src/message/namespace.prop.ts` の SUBSCRIBE_NAMESPACE テストは `encodeSubscribeNamespacePayload` / `decodeSubscribeNamespacePayload` の payload 単位での round-trip しか検証しておらず、`session.ts` 側で行っているフレーミング (Type + Length + Payload) の組み立てはテストに含まれていない。

## 修正方針

手動フレーミングをやめ、`ControlStreamWriter.encode()` を流用する。Control Message のフレーミングは仕様で統一されているため、SUBSCRIBE_NAMESPACE のためだけに別実装を持つ理由がない。

## テスト追加方針

session.ts の送信バイト列を `ControlStreamReader` に流し込んで Type / Length / Payload が正しく復元できることを検証する round-trip テストを追加する。
