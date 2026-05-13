# FETCH_OK の End Location が Start Location 以上であることの検証がない

Created: 2026-03-29
Model: Claude Opus 4.6

## 問題

`src/session.ts` の FETCH_OK 受信時に End Location が FETCH で指定した Start Location 以上であることを検証していない。

## 根拠

refs/moq/draft-ietf-moq-transport-17.txt Section 9.15:

> If End Location is smaller than the Start Location in the
> corresponding FETCH the receiver MUST close the session with a
> PROTOCOL_VIOLATION.

## 該当箇所

- `src/session.ts` `readFetchResponse()`

## 期待される動作

FETCH_OK の End Location が FETCH の Start Location より小さい場合、PROTOCOL_VIOLATION でセッションを閉じるべき。

Completed: 2026-03-29

## 解決方法

readFetchResponse() で FETCH_OK の End Location が FETCH の Start Location より小さい場合に PROTOCOL_VIOLATION でセッションを閉じるようにした。pendingFetch に startLocation を保持するようにした。
