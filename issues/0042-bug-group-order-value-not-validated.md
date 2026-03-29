# GROUP_ORDER の値検証がない

Created: 2026-03-29
Model: Claude Opus 4.6

## 問題

受信した GROUP_ORDER パラメータの値が 0x1 (Ascending) または 0x2 (Descending) であることを検証していない。

## 根拠

refs/moq/draft-ietf-moq-transport-17.txt Section 9.3.6 (line 2987-2995):

> The allowed values are Ascending (0x1) or Descending (0x2).  If an
> endpoint receives a value outside this range, it MUST close the
> session with PROTOCOL_VIOLATION.

## 期待される動作

GROUP_ORDER パラメータの値が 0x1 または 0x2 以外の場合、PROTOCOL_VIOLATION でセッションを閉じるべき。
