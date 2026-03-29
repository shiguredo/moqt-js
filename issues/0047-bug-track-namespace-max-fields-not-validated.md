# Track Namespace の 32 フィールド上限検証がない

Created: 2026-03-29
Model: Claude Opus 4.6

## 問題

受信した Track Namespace のフィールド数が 32 を超えないことを検証していない。合計サイズの 4,096 バイト制限はあるが、フィールド数の制限がない。

## 根拠

refs/moq/draft-ietf-moq-transport-17.txt Section 9.20 (line 4322-4324):

> receives a Track Namespace Prefix consisting of greater than
> 32 Track Namespace Fields, it MUST close the session with a
> PROTOCOL_VIOLATION.

## 該当箇所

- `src/message/parameter.ts` `decodeTrackNamespace()` (line 164-186)

## 期待される動作

Track Namespace のフィールド数が 32 を超える場合、エラーを返すべき。
