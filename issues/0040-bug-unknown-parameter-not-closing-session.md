# 未知の Message Parameter でセッションを閉じていない

Created: 2026-03-29
Model: Claude Opus 4.6

## 問題

`src/message/parameter.ts` の `getMessageParameterValueEncoding()` が未知のパラメータ型に対して `"length-prefixed"` をフォールバックで返し、エラーにしない。

## 根拠

refs/moq/draft-ietf-moq-transport-17.txt Section 9.3 (line 2665-2669):

> All Message Parameters MUST be defined in the negotiated version of
> MOQT or negotiated via Setup Options. An endpoint that receives an
> unknown Message Parameter MUST close the session with
> PROTOCOL_VIOLATION.

## 該当箇所

- `src/message/parameter.ts` `getMessageParameterValueEncoding()` (line 451)

## 期待される動作

未知のパラメータ型を受信した場合、エラーを返してセッションを PROTOCOL_VIOLATION で閉じるべき。
