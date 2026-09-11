# 同一 Track の別 pending 購読 / FETCH が malformed 検出で cross-cancel されない

- Created: 2026-09-12
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-pending-track-cross-cancel
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-transport-21 §12.1 は「it MUST cancel any corresponding subscription or fetches for that Track from that publisher」と定める。§3.1 は subscription の状態として Pending (Subscriber) と Established を定義し、Pending (Subscriber) も購読として STOP_SENDING による終了の対象である。しかし現状、malformed 検出時の cross-cancel は Established の購読 / FETCH に限られ、同一 Full Track Name の別 pending 購読 / FETCH が残留する。

## 現状

- `src/session/bidi.ts` の `cancelMalformedTrackPeers` は `session.subscribersByAlias` と `session.fetchers` のみを走査し、`session.pendingSubscribe` / `session.pendingFetch` は参照しない。
- 同一 Track への複数同時購読は §3.1 で許容され、`session.subscribe()` / `session.fetch()` に同一 Track の重複送信ガードはない。
- malformed 検出時に削除されるのは検出元の pending のみで、同一 Track の別 pending は残留する。その応答が well-formed であれば、malformed と判定済みの Track の購読 / FETCH が確立してしまう。
- 検出経路は SUBSCRIBE_OK / FETCH_OK の malformed 検出 (`bidiReadSubscribeResponse` / `bidiReadFetchResponse`) と subgroup / datagram / fetch / fill の各経路であり、いずれも `cancelMalformedTrackPeers` を通る。

## 設計方針

1. `cancelMalformedTrackPeers` の走査対象に `session.pendingSubscribe` / `session.pendingFetch` を追加し、`impl.getFullTrackName()` が一致する pending を cancel する。検出元の pending は呼び出し側で先に delete 済みのため、除外指定は不要。
2. pending 購読の cancel は既存の MalformedTrackError 分岐と同じく `pending.reject(error)` → `impl.markClosed()` → `bidiCancelSubscription` の順で行う。pending FETCH は `pending.reject(error)` → `bidiCancelFetch` → `fireFetcherReadyCallbacks`。
3. アプリへの通知は pending の reject と既存購読 / FETCH の error コールバックで二重にならないようにする。
4. 同一 Track の別 pending が cancel され、別 Track の pending が残ることを検証するテストを追加する。

## 完了条件

- 同一 Full Track Name の別 pending 購読 / FETCH が malformed 検出で cancel (reject とストリーム cancel) されること。
- 別 Track の pending 購読 / FETCH は cancel されないこと。
- 上記を検証するテストがあること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。
- `CHANGES.md` の `## develop` に `[FIX]` を追加すること。

## 関連

- draft-ietf-moq-transport-21 §3.1 / §12.1
- `cancelMalformedTrackPeers` / `bidiReadSubscribeResponse` / `bidiReadFetchResponse` / `bidiCancelSubscription` / `bidiCancelFetch` (`src/session/bidi.ts`)
- `PendingSubscribe` / `PendingFetch` (`src/session/bidi.ts`)
- `issues/closed/0567-bug-subscribe-ok-fetch-ok-cross-cancel.md` (SUBSCRIBE_OK / FETCH_OK の Established cross-cancel)
- `issues/closed/0557-bug-malformed-track-cross-cancel.md` (データストリーム経路の Established cross-cancel)
