# SUBSCRIBE_OK / FETCH_OK の未知 Mandatory Track Property で購読 / fetch を cancel する

- Created: 2026-09-08
- Completed: 2026-09-09
- Branch: feature/fix-subscribe-ok-mandatory-property-cancel
- Polished: 2026-09-08

## 目的

draft-ietf-moq-transport-21 §3.6 は、未知の Mandatory Track Property を SUBSCRIBE_OK / FETCH_OK で受信したとき、購読 / fetch を cancel することを MUST とする。現状は Promise を reject して state を削除するだけで、ストリームを cancel しない。

## 現状

- `src/session/bidi.ts` の `bidiReadSubscribeResponse` の catch 節は、`MalformedTrackError` を含む非 protocol violation エラーで `pendingSubscribe` / `requestStreams` / `fillFetchTargets` を削除してから `pending.reject(...)` を行う。`bidiReadFetchResponse` の catch 節も `pendingFetch` / `requestStreams` を削除して `fireFetcherReadyCallbacks` を呼び、`pending.reject(...)` を行う。いずれも `RESET_STREAM` / `STOP_SENDING` は送らない。
- `src/properties.ts` の `decodeProperties` は未知 Mandatory Track Property (0x4000-0x7FFF) で `MalformedTrackError` を投げる。`toProtocolViolationSessionError` は `MalformedTrackError` を変換しないため、上記 catch の非 protocol violation 経路に落ちる。
- §3.6:「For SUBSCRIBE_OK messages: the subscriber MUST cancel the subscription (see Section 6.4.2.3).」「For FETCH_OK messages: the subscriber MUST cancel the fetch (see Section 6.4.2.3).」
- §6.4.2.3 の cancel は送信方向の `RESET_STREAM` と受信方向の `STOP_SENDING` で行う。
- closed の `issues/closed/0326-bug-mandatory-track-properties-handling.md` が同じ MUST を扱い、設計方針で「catch ブロックに `MalformedTrackError` の分岐を追加し、`pending.reject(error)` で Promise を reject する。呼び出し元が reject を処理してサブスクリプション / フェッチをキャンセルする」とし、完了条件に「サブスクリプション / フェッチがキャンセルされること」を掲げて closed になった。しかし対応コミットの変更は `decodeProperties` の検出追加が中心で、`bidiCancelSubscription` / `bidiCancelFetch` の呼び出しは入っていない。本 issue はその未達残件を実装する。

## 設計方針

1. SUBSCRIBE_OK / FETCH_OK のデコードで `MalformedTrackError` を捕捉したら、当該 bidi ストリームを §6.4.2.3 に従って cancel する。
2. cancel は既存の `bidiCancelSubscription` / `bidiCancelFetch` を使う。両関数は `session.requestStreams.get(requestId)` が存在するときだけ writer / reader を cancel するため、**cancel 呼び出しは `requestStreams.delete(requestId)` より前**に行う（または cancel 関数側で state 削除まで行い、catch の削除を委譲する）。順序を誤ると cancel が発火しない。
3. FETCH の cancel では §3.2.1 に従い、bidi リクエストストリームへの `STOP_SENDING` を MUST とし、開いている FETCH データストリームへの `STOP_SENDING` は MAY のため本実装では送る。SUBSCRIBE の購読側はデータストリームを送信しないため、§3.6 のデータストリーム reset MUST（Relay 向け）は本 client ライブラリの対象外とする。
4. 未知 Mandatory Track Property を含む SUBSCRIBE_OK / FETCH_OK で cancel が呼ばれるテストを追加する。

## 完了条件

- 未知 Mandatory Track Property を含む SUBSCRIBE_OK / FETCH_OK で、該当 bidi ストリームが cancel されること。
- pending / requestStreams / fillFetchTargets などの state が残留しないこと。
- FETCH では bidi リクエストストリームが cancel され、開いているデータストリームに `STOP_SENDING` が送られること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 関連

- draft-ietf-moq-transport-21 §3.6 / §6.4.2.3 / §3.2.1
- `bidiReadSubscribeResponse` / `bidiReadFetchResponse`
- `bidiCancelSubscription` / `bidiCancelFetch`
- `decodeProperties` / `MalformedTrackError`
- `issues/closed/0326-bug-mandatory-track-properties-handling.md`（未達の先行 issue）

## 解決方法

SUBSCRIBE_OK / FETCH_OK のデコードで `MalformedTrackError` を捕捉したとき、bidi リクエストストリームを cancel するようにした。

- `bidiReadSubscribeResponse` の catch に `MalformedTrackError` 分岐を追加し、`pending.reject(error)` の後に `pending.impl.markClosed()` してから `bidiCancelSubscription` を呼ぶ。`markClosed` は進行中の fill fetch ストリームの sink が malformed track の Object を破棄するために必要
- `bidiReadFetchResponse` の catch に `MalformedTrackError` 分岐を追加し、`pending.reject(error)` の後に `bidiCancelFetch` を呼び、`fireFetcherReadyCallbacks` で待機者を起こす。待機者は fetcher 不在で null 解決し、既存経路で FETCH データストリームが `reader.cancel` (STOP_SENDING 相当) される
- `requestStreams` の削除は cancel 関数へ委譲し、手動削除より先に cancel が発火するようにした
- `src/session/bidi.test.ts` に SUBSCRIBE_OK / FETCH_OK の未知 Mandatory Track Property で cancel (abort / cancel) が到達し、state が残留しないことを検証するテストを追加した
- `CHANGES.md` の `## develop` に `[FIX]` を追記した
