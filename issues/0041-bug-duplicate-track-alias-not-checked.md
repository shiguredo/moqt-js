# Track Alias の重複チェックがない

Created: 2026-03-29
Model: Claude Opus 4.6

## 問題

`src/session.ts` の SUBSCRIBE_OK 受信時に Track Alias の重複チェックを行わず、`subscribersByAlias.set()` で上書きしている。

## 根拠

refs/moq/draft-ietf-moq-transport-17.txt Section 9.9 (line 3545-3550):

> The same Track Alias MUST NOT be used by a publisher to refer to two
> different Tracks simultaneously in the same session. If a subscriber
> receives a SUBSCRIBE_OK that uses the same Track Alias as a different
> track with an Established subscription, it MUST close the session with
> error DUPLICATE_TRACK_ALIAS.

## 該当箇所

- `src/session.ts` `readSubscribeResponse()` (line 2337)

## 期待される動作

SUBSCRIBE_OK 受信時に既存の subscribersByAlias に同じ Track Alias が別のトラックで登録済みの場合、DUPLICATE_TRACK_ALIAS でセッションを閉じるべき。
