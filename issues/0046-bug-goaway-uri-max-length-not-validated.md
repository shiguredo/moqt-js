# GOAWAY URI の最大長検証がない

Created: 2026-03-29
Model: Claude Opus 4.6

## 問題

`src/session.ts` の `handleGoaway()` で GOAWAY メッセージの New Session URI の長さが最大 8,192 バイトであることを検証していない。

## 根拠

refs/moq/draft-ietf-moq-transport-17.txt Section 9.5 (line 3314-3316):

> The maximum length of the New Session URI is 8,192 bytes. If an
> endpoint receives a length exceeding the maximum, it MUST close the
> session with a PROTOCOL_VIOLATION.

## 該当箇所

- `src/session.ts` `handleGoaway()` (line 2708-2728)
- `src/message/session.ts` `decodeGoawayPayload()`

## 期待される動作

GOAWAY メッセージの URI 長が 8,192 バイトを超える場合、PROTOCOL_VIOLATION でセッションを閉じるべき。
