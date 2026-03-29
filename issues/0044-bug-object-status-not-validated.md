# Object Status の検証がない

Created: 2026-03-29
Model: Claude Opus 4.6

## 問題

`src/dataStream.ts` で Object Status を `Number(statusVal) as ObjectStatus` でキャストしているだけで、0x0 (NORMAL) / 0x3 (END_OF_GROUP) / 0x4 (END_OF_TRACK) 以外の値を検証していない。

## 根拠

refs/moq/draft-ietf-moq-transport-17.txt Section 10.2.1.1 (line 4541-4543):

> Any other value SHOULD be treated as a protocol error and the session
> SHOULD be closed with a PROTOCOL_VIOLATION (Section 3.5).  Any object
> with a status code other than zero MUST have an empty payload.

## 該当箇所

- `src/dataStream.ts` line 376, 671, 1153

## 期待される動作

Object Status が 0x0, 0x3, 0x4 以外の場合、エラーを返すべき。
