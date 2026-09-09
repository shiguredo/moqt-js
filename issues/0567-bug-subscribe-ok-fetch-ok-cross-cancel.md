# SUBSCRIBE_OK / FETCH_OK の malformed 検出で同一 Track の購読と FETCH を相互に cancel する

- Created: 2026-09-09
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-subscribe-ok-fetch-ok-cross-cancel
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-transport-21 §12.1 は「it MUST cancel any corresponding subscription or fetches for that Track from that publisher」と定める。SUBSCRIBE_OK / FETCH_OK のデコードで malformed track (未知 Mandatory Track Property 等) を検出したとき、現状は当該 pending の購読 / FETCH のみを cancel し、同一 Track の既存購読 / FETCH を cancel しない。

## 現状

- `src/session/bidi.ts` の `bidiReadSubscribeResponse` は、`MalformedTrackError` の分岐で `pending.impl.markClosed()` と `bidiCancelSubscription(session, pending.impl)` のみを呼ぶ。
- `src/session/bidi.ts` の `bidiReadFetchResponse` は、`MalformedTrackError` の分岐で `bidiCancelFetch(session, pending.impl)` のみを呼ぶ。
- 同一 Track に既存の購読 / FETCH が確立している場合（同一 Full Track Name の別 requestId）、それらは cancel されない。§12.1 の MUST は Track 単位であり、`cancelMalformedTrackPeers` が Full Track Name で全購読 / 全 FETCH を cancel する。
- ただし pending の購読 / FETCH は `subscribersByAlias` / `fetchers` にまだ登録されていないため、`cancelMalformedTrackPeers` だけでは当該 pending を cancel できない。

## 設計方針

1. `bidiReadSubscribeResponse` / `bidiReadFetchResponse` の `MalformedTrackError` 分岐で、pending の購読 / FETCH を cancel したうえで、`cancelMalformedTrackPeers` に `pending.impl.getFullTrackName()` を渡して同一 Track の既存購読 / FETCH も cancel する。
2. pending の購読は fill 配信を止めるため `markClosed()` を cancel 前に呼ぶ既存挙動を維持する。
3. セッションは閉じない。アプリへの通知は pending の `reject` と既存購読 / FETCH の error コールバックで二重にならないようにする。
4. SUBSCRIBE_OK / FETCH_OK の malformed で、pending と同一 Track の既存購読 / FETCH が双方 cancel されるテストを追加する。

## 完了条件

- SUBSCRIBE_OK の malformed 検出で、pending の購読と同一 Full Track Name の既存購読 / FETCH が cancel されること。
- FETCH_OK の malformed 検出で、pending の FETCH と同一 Full Track Name の既存購読 / FETCH が cancel されること。
- セッションは閉じないこと。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 関連

- draft-ietf-moq-transport-21 §12.1 / §3.6 / §9.7 / §9.12
- `bidiReadSubscribeResponse` / `bidiReadFetchResponse` / `cancelMalformedTrackPeers`（`src/session/bidi.ts`）
- `FetcherImpl.getFullTrackName`（`src/fetcher.ts`）
- `issues/closed/0557-bug-malformed-track-cross-cancel.md`（データストリーム経路の cross-cancel）
- `issues/closed/0538-bug-subscribe-ok-mandatory-property-cancel.md`（SUBSCRIBE_OK / FETCH_OK の単一 cancel）
