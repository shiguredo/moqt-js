# Datagram の Properties Length = 0 で PROPERTIES ビット有効時の検証がない

Created: 2026-03-29
Model: Claude Opus 4.6

## 問題

`src/dataStream.ts` の `decodeObjectDatagram()` で PROPERTIES ビットが有効だが Properties Length が 0 の場合を検証していない。

## 根拠

refs/moq/draft-ietf-moq-transport-17.txt Section 10.3.1:

> If an endpoint receives a datagram with the PROPERTIES bit set and
> an Properties Length of 0, it MUST close the session with a
> PROTOCOL_VIOLATION.

## 該当箇所

- `src/dataStream.ts` `decodeObjectDatagram()` (line 689-698)

## 期待される動作

PROPERTIES ビットが有効で Properties Length が 0 の場合、エラーを返すべき。
