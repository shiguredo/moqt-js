# 未知のメッセージ型でセッションを閉じていない

Created: 2026-03-29
Model: Claude Opus 4.6

## 問題

`src/session.ts` の `handleControlMessage()` と `readRequestStreamMessages()` で未知のメッセージ型を受信した場合、無視している。

## 根拠

refs/moq/draft-ietf-moq-transport-17.txt Section 9 (line 2562-2568):

> An endpoint that receives an unknown message type MUST close the
> session.  Control messages have a length to make parsing easier, but
> no control messages are intended to be ignored.

## 該当箇所

- `src/session.ts` `handleControlMessage()`: switch に default がない
- `src/session.ts` `readRequestStreamMessages()`: default で無視している (line 2534-2536)

## 期待される動作

未知のメッセージ型を受信した場合、セッションを閉じるべき。
