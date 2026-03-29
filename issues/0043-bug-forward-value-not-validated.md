# FORWARD パラメータの値検証がない

Created: 2026-03-29
Model: Claude Opus 4.6

## 問題

受信した FORWARD パラメータの値が 0 または 1 であることを検証していない。

## 根拠

refs/moq/draft-ietf-moq-transport-17.txt Section 9.3.10 (line 3054-3060):

> The allowed values are 0 (don't forward) or 1 (forward).  If an
> endpoint receives a value outside this range, it MUST close the
> session with PROTOCOL_VIOLATION.

## 期待される動作

FORWARD パラメータの値が 0 または 1 以外の場合、PROTOCOL_VIOLATION でセッションを閉じるべき。
