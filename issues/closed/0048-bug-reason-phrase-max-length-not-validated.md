# Reason Phrase の最大長検証がない

Created: 2026-03-29
Model: Claude Opus 4.6

## 問題

REQUEST_ERROR, PUBLISH_DONE の Reason Phrase の長さが最大 1,024 バイトであることを検証していない。

## 根拠

refs/moq/draft-ietf-moq-transport-17.txt Section 1.4.4 (line 657-661):

> Reason Phrase Length: A variable-length integer specifying the
> length of the reason phrase in bytes. The reason phrase length
> has a maximum value of 1024 bytes. If an endpoint receives a
> length exceeding the maximum, it MUST close the session with a
> PROTOCOL_VIOLATION

## 該当箇所

- `src/message/session.ts` `decodeRequestErrorPayload()` (line 206-225)
- `src/message/publish.ts` `decodePublishDonePayload()` (line 223-247)

## 期待される動作

Reason Phrase の長さが 1,024 バイトを超える場合、エラーを返すべき。

Completed: 2026-03-29

## 解決方法

MAX_REASON_PHRASE_LENGTH = 1024 定数を追加し、decodeRequestErrorPayload() と decodePublishDonePayload() で Reason Phrase 長 > 1,024 バイトの検証を追加した。
