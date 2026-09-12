# 同一 Track の別 pending 購読 / FETCH が malformed 検出で cross-cancel されない

- Created: 2026-09-12
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-pending-track-cross-cancel
- Polished: 2026-09-12

## 目的

draft-ietf-moq-transport-21 §12.1 は「it MUST cancel any corresponding subscription or fetches for that Track from that publisher」と定める。§3.1 は subscription の状態として Pending (Subscriber) を含み、Pending (Subscriber) も STOP_SENDING による終了の対象である。しかし現状、malformed 検出時の cross-cancel は Established の購読 / FETCH に限られ、同一 Full Track Name の別 pending 購読 / FETCH が残留する。残留した pending は、後から well-formed な応答を受信すると確立してしまう。

## 再現手順

1. 同一 Full Track Name に対し requestId A / B の SUBSCRIBE を送る (両方 pending になる)
2. A の SUBSCRIBE_OK を未知 Mandatory Track Property 付きで受信する (malformed 検出)
3. B の SUBSCRIBE_OK を well-formed で受信する
4. 現状は B が確立してしまう (本来は A の malformed 検出時点で B も cancel されるべき)
5. FETCH でも同様 (同一 Track の複数 FETCH で 1 本目の FETCH_OK が malformed でも 2 本目が確立する)

## 現状

- `src/session/bidi.ts` の `cancelMalformedTrackPeers` は `session.subscribersByAlias` と `session.fetchers` のみを走査し、`session.pendingSubscribe` / `session.pendingFetch` は参照しない。
- 同一 Track への複数同時購読は §3.1 で許容され、`session.subscribe()` / `session.fetch()` に同一 Track の重複送信ガードはない。
- malformed 検出時に削除されるのは検出元の pending のみである。検出元の pending は SUBSCRIBE_OK / FETCH_OK 経路では delete 済みだが、fill 経路では `fillFetchTargets` が SUBSCRIBE_OK 後も保持されるため検出元が pending のまま残る場合がある。
- 検出経路は SUBSCRIBE_OK / FETCH_OK の malformed 検出と subgroup / datagram / fetch / fill の各経路であり、いずれも `cancelMalformedTrackPeers` を通る。
- pending の応答待ちでは `bidiReadResponseFromBidiStream` が取得した reader が readable をロックしたままで、`RequestStreamInfo.reader` には登録されない。このため `bidiCancelSubscription` / `bidiCancelFetch` はロック中の `stream.readable.cancel()` を呼び、TypeError で握り潰されて STOP_SENDING が届かない。
- さらに `bidiReadResponse` は読み取り開始時に捕捉した pending を保持し続けるため、cancel 後に well-formed な応答が届くと `handleOk` が `session.subscribers` / `session.fetchers` へ登録し、購読 / FETCH が確立する。

## 設計方針

1. `cancelMalformedTrackPeers` の走査対象に `session.pendingSubscribe` / `session.pendingFetch` を追加し、`impl.getFullTrackName()` が一致する pending を cancel する。検出元の pending も除外せず cancel 対象に含める (fill 経路では検出元が pending のまま残る場合がある)。
2. pending の cancel は次の順で行う: `session.pendingSubscribe.delete(requestId)` / `session.pendingFetch.delete(requestId)` → `pending.reject(error)` → (`impl.markClosed()`) → `bidiCancelSubscription` / `bidiCancelFetch`。pending には `bidiCancelSubscriptionWithError` を使わない。`SubscriberImpl.state` は pending 中も `active` のため、state ガードでは pending の reject と error コールバックの二重通知を防げない (FETCH も同様)。
3. 応答待ちの reader を `RequestStreamInfo.reader` に登録し、`bidiCancelSubscription` / `bidiCancelFetch` が保持者経由で `reader.cancel` (STOP_SENDING 相当) できるようにする。`bidiCancelFetch` も reader 経由の cancel に対応させる。
4. cancel 済みの pending に遅延して well-formed な応答が届いても確立しないようにする。`bidiReadResponse` で応答受信後に pending の在否を再確認するか、`handleOk` で `impl.state === "active"` を検証する。
5. 同一 Track の別 pending が cancel され、別 Track の pending が残ることを検証するテストを追加する。bidi 応答経路は実 W3C ストリームを同時実行してロック状態での cancel 到達 (reject と STOP_SENDING) を検証し、データストリーム経路は代表を追加する。

## 完了条件

- 同一 Full Track Name の別 pending 購読 / FETCH が malformed 検出で cancel (reject とストリーム cancel) されること。
- cancel した pending が `pendingSubscribe` / `pendingFetch` から削除されていること。
- cancel した pending に遅延して well-formed な応答が届いても購読 / FETCH が確立しないこと。
- pending 自身への error コールバックが二重発火しないこと。
- 別 Track の pending 購読 / FETCH は cancel されないこと。
- セッションは閉じないこと。
- 上記を検証するテストがあること (`src/session/bidi.test.ts`、必要に応じて `src/session.test.ts`)。
- 既存の `cancelMalformedTrackPeers` 単体テストの部分セッションを新しい走査対象に追随させること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。
- `CHANGES.md` の `## develop` に `[FIX]` を追加すること。

## 関連

- draft-ietf-moq-transport-21 §3.1 / §12.1
- `cancelMalformedTrackPeers` / `bidiReadSubscribeResponse` / `bidiReadFetchResponse` / `bidiCancelSubscription` / `bidiCancelFetch` / `bidiReadResponseFromBidiStream` / `RequestStreamInfo` (`src/session/bidi.ts`)
- `PendingSubscribe` / `PendingFetch` (`src/session/bidi.ts`)
- `issues/0574-bug-full-track-name-collision.md` (getFullTrackName の比較を増やすため、先行して実施する)
- `issues/0573-bug-fetcher-double-error-notify.md` (同じ `cancelMalformedTrackPeers` / `bidiCancelFetch` を扱う。実施順を調整する)
- `issues/0576-refactor-bidi-test-split.md` (テスト総数の記載が古くなるため、実施後に更新する)
- `issues/closed/0567-bug-subscribe-ok-fetch-ok-cross-cancel.md` (Established の cross-cancel)
- `issues/closed/0557-bug-malformed-track-cross-cancel.md` (データストリーム経路の Established cross-cancel)

## 解決方法

- `cancelMalformedTrackPeers` の走査対象に `session.pendingSubscribe` / `session.pendingFetch` を追加し、同一 Full Track Name の pending を Map 削除 → reject → markClosed → cancel するようにした
- 応答待ちの reader を `RequestStreamInfo.reader` に登録し、`bidiCancelFetch` も reader 経由の cancel に対応させた
- `bidiReadResponse` に pending の在否再確認を追加し、cancel 済み pending への遅延応答では購読 / FETCH を確立しないようにした
- 送信準備中の cross-cancel に備え、pending 不在で早期 return する経路でもストリームを cancel / abort して `requestStreams` から削除するようにした
- pending FETCH の cross-cancel 後に `fireFetcherReadyCallbacks` を呼び、`incomingWaitForFetcher` の待機を即時解決するようにした
- テストを 3 件追加し、既存テストの部分セッションに `pendingSubscribe` / `pendingFetch` / `fetcherReadyCallbacks` を追加した
- `CHANGES.md` の `## develop` に [FIX] を追加した
