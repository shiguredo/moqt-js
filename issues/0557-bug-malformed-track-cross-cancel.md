# malformed track 検出時に同一 Track の購読と FETCH を相互に cancel する

- Created: 2026-09-09
- Completed: YYYY-MM-DD
- Branch: feature/fix-malformed-track-cross-cancel
- Polished: YYYY-MM-DD

## 目的

draft-ietf-moq-transport-20 §2.4.2 は「it MUST cancel any corresponding subscription or fetches for that Track from that publisher」と定める。現状は購読の malformed 検出で当該購読のみ、FETCH の malformed 検出で当該 FETCH のみを cancel し、同一 Track の他方（FETCH / 購読）を cancel しない。

## 現状

- `src/session.ts` の `handleMalformedSubgroupTrack` は当該 alias の購読を cancel するが、同一 Track の FETCH は cancel しない。
- `src/session.ts` の `handleMalformedFetchTrack` は当該 FETCH を cancel するが、同一 Track の購読は cancel しない。
- datagram 経路の cancel も購読のみを対象とする。

## 設計方針

1. malformed track 検出時、同一 Track に紐づく購読と FETCH を両方 cancel する。
2. Track の同一性判定方法（trackAlias / Full Track Name）を実装時に確定する。
3. subgroup / datagram / fetch / fill の各検出経路を同じ cancel 経路に接続する。

## 完了条件

- malformed track 検出で同一 Track の購読と FETCH が両方 cancel されること。
- セッションは INTERNAL_ERROR で閉じないこと。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 関連

- draft-ietf-moq-transport-20 §2.4.2 / §2.5.1
- `handleMalformedSubgroupTrack` / `handleMalformedFetchTrack` / `bidiCancelSubscriptionWithError` / `bidiCancelFetch`
