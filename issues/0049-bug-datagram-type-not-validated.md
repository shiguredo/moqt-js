# Object Datagram の不正タイプ値の検証がない

Created: 2026-03-29
Model: Claude Opus 4.6

## 問題

`src/dataStream.ts` の `decodeObjectDatagram()` で不正な Datagram タイプ値を検証していない。

## 根拠

refs/moq/draft-ietf-moq-transport-17.txt Section 10.3.1:

> The following Type values are invalid. If an endpoint receives a
> datagram with any of these Type values, it MUST close the session
> with a PROTOCOL_VIOLATION:
>
> * Type values with both the STATUS bit (0x20) and END_OF_GROUP bit
>   (0x02) set: 0x22, 0x23, 0x26, 0x27, 0x2A, 0x2B, 0x2E, 0x2F.
>
> * Type values that do not match the form 0b00X0XXXX (i.e., Type
>   values outside the ranges 0x00..0x0F and 0x20..0x2F).

## 該当箇所

- `src/dataStream.ts` `decodeObjectDatagram()` (line 660)

## 期待される動作

不正なタイプ値を受信した場合、エラーを返すべき。
