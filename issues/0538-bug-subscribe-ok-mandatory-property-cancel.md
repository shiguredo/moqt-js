# SUBSCRIBE_OK / FETCH_OK の未知 Mandatory Track Property で購読 / fetch を cancel する

- Created: 2026-09-08
- Completed: YYYY-MM-DD
- Branch: feature/fix-subscribe-ok-mandatory-property-cancel
- Polished: YYYY-MM-DD

## 目的

draft-ietf-moq-transport-20 §2.5.1 は、未知の Mandatory Track Property を SUBSCRIBE_OK / FETCH_OK で受信したとき、購読 / fetch を cancel することを MUST とする。現状は Promise を reject するだけで、ストリームを cancel しない。

## 現状

- `src/session/bidi.ts` の `bidiReadSubscribeResponse` / `bidiReadFetchResponse` の catch 節は、`MalformedTrackError` を含む非 protocol violation エラーで `pending.reject(...)` のみを行う。
- `toProtocolViolationSessionError` は `MalformedTrackError` を変換しないため、この経路に落ちる。
- §2.5.1:「For SUBSCRIBE_OK messages: the subscriber MUST cancel the subscription (see Section 3.3.3).」「For FETCH_OK messages: the subscriber MUST cancel the fetch (see Section 3.3.3).」
- §3.3.3 の cancel は送信方向の `RESET_STREAM` と受信方向の `STOP_SENDING` で行う。

## 設計方針

1. SUBSCRIBE_OK / FETCH_OK のデコードで `MalformedTrackError`（未知 Mandatory Track Property 由来）を捕捉したら、当該 bidi ストリームを §3.3.3 に従って cancel する。
2. 既存の `bidiCancelSubscription` / `bidiCancelFetch` を再利用し、pending / requestStreams / fillFetchTargets の削除と整合させる。
3. 関連するデータストリームが既に開いている場合は、購読 / fetch の cancel 方針に従って停止する。
4. 未知 Mandatory Track Property を含む SUBSCRIBE_OK / FETCH_OK で cancel が呼ばれるテストを追加する。

## 完了条件

- 未知 Mandatory Track Property を含む SUBSCRIBE_OK / FETCH_OK で、該当 bidi ストリームが cancel されること。
- pending / requestStreams などの state が残留しないこと。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 関連

- draft-ietf-moq-transport-20 §2.5.1 / §3.3.3
- `bidiReadSubscribeResponse` / `bidiReadFetchResponse`
- `bidiCancelSubscription` / `bidiCancelFetch`
- `decodeProperties` / `MalformedTrackError`
