# malformed 検出の重複で fetcher の error コールバックが二重発火する

- Created: 2026-09-12
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-fetcher-double-error-notify
- Polished: 2026-09-12

## 目的

draft-ietf-moq-transport-21 §12.1 は「When a subscriber detects a Malformed Track, it MUST cancel any corresponding subscription or fetches for that Track from that publisher (see Section 6.4.2.3), and SHOULD deliver an error to the application.」と定める。現状の `cancelMalformedTrackPeers` は fetcher の error コールバックが二重に呼ばれ得る窓があり、同一 Track の malformed 検出が重なるとアプリが同じエラーを 2 回受け取る。同一 Track の同一事象に対する通知は 1 回で足りる。

## 現状

- `src/session/bidi.ts` の `cancelMalformedTrackPeers` は、fetcher に対して `fetcher.handleError(error)` を呼んでから `void fetcher.cancel()` を呼ぶ。
- `src/fetcher.ts` の `FetcherImpl.handleError` は `state === "closed"` のときだけ抑止し、呼び出しでは state を変えない。
- `FetcherImpl.cancel` は冒頭で `state === "closed"` なら早期 return し、state を closed にするのは `await this.onCancel()` の完了後である。実運用の `onCancel` は `bidiCancelFetch` を呼び、`bidiCancelFetch` は `await streamInfo.reader.cancel(...)` (または `streamInfo.stream.readable.cancel(...)`) の後に `session.fetchers.delete(requestId)` する。
- したがって最初の検出から `bidiCancelFetch` の await が完了するまでの間、同一 fetcher は active のまま `session.fetchers` に残る。この間に別経路 (subgroup / datagram / fetch / fill の malformed 検出や `cancelMalformedTrackPeers` の再入) が同じ fetcher を拾うと `handleError` が再度呼ばれ、error コールバックが 2 回呼ばれる。
- 購読側は `bidiCancelSubscriptionWithError` が `subscriber.handleError(error)` → `subscriber.markClosed()` を同期区間で行ってから `await bidiCancelSubscription(...)` するため二重通知しない。fetcher 側だけがこの形になっていない。
- `FetcherImpl.cancel` の冒頭に早期 return があるため、`cancelMalformedTrackPeers` で `markClosed()` を先に呼んでから `cancel()` を呼ぶと `onCancel()` が実行されず、§3.2.1 の MUST「It MUST send STOP_SENDING for the bidi request stream.」が満たされなくなる。

## 設計方針

1. `cancelMalformedTrackPeers` の fetcher ループを購読側 (`bidiCancelSubscriptionWithError`) と同形にする: `fetcher.handleError(error)` → `fetcher.markClosed()` → `void bidiCancelFetch(session, fetcher).catch(() => {})`。`fetcher.cancel()` は closed で早期 return するため使わない (`markClosed()` の後に `cancel()` を呼ぶと §3.2.1 の STOP_SENDING が送られない)。既に `state === "closed"` の fetcher はループ先頭でスキップし、通知もストリーム後始末も 1 回目のみで行う (`bidiCancelFetch` を重複して呼ばない)。
2. `bidiCancelFetch` は fetcher の state を変更しない現行のままとする (state の更新は呼び出し元の責務)。キャンセルに伴うストリーム後始末 (`readable.cancel` / `writer.abort` / `requestStreams` と `session.fetchers` の削除 / `onRequestDrained`) は従来どおり `bidiCancelFetch` が行う。
3. 新しい state ("cancelling" 等) は追加しない。`FetcherState` は公開インターフェース `Fetcher` の `state` として公開されており、値の追加は利用者の `state` 判定の意味を変える後方互換の破壊になる。
4. pending fetch のループは現行のまま (`session.pendingFetch.delete` → `pending.reject(error)` → `bidiCancelFetch`) とする。pending は reject 経由で `markClosed` されるため二重通知しない。
5. 重複する malformed 検出でも error コールバックが 1 回だけ呼ばれることを検証するテストを追加する。テストは `requestStreams` に実ストリームを登録して 1 回目のキャンセルが await で保留される状況を作り、その間に同一 `trackKey` で `cancelMalformedTrackPeers` をもう一度呼ぶ (変更前の実装では error コールバックが 2 回呼ばれる)。

## 完了条件

- 同一 fetcher に対して malformed 検出が重複しても error コールバックが 1 回だけ呼ばれること (重複検出は `cancelMalformedTrackPeers` の再入で再現する)。
- §3.2.1 の MUST を維持すること: キャンセル時に `readable.cancel` (STOP_SENDING 相当) と `writer.abort` が呼ばれ、`requestStreams` / `session.fetchers` のエントリが削除されること (非退行)。
- 購読側 (`bidiCancelSubscriptionWithError` と `cancelMalformedTrackPeers` の購読ループ) の二重通知防止と削除集合が従来どおりであること (非退行)。
- pending fetch の cross-cancel (reject と `session.pendingFetch` の削除) が従来どおりであること (非退行)。
- 上記を検証するテストがあること (既存の `cancelMalformedTrackPeers` のテストと同じ `src/session/bidi.test.ts` に追加する。実ストリームの `readable.cancel` を未解決 Promise にして窓を開き、変更前の実装では error コールバックが 2 回、変更後は 1 回になることを検証する)。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。
- `CHANGES.md` の `## develop` に `[FIX]` を追加すること。

## 関連

- draft-ietf-moq-transport-21 §12.1 / §3.2.1 / §6.4.2.3
- `cancelMalformedTrackPeers` / `bidiCancelFetch` / `bidiCancelSubscriptionWithError` (`src/session/bidi.ts`)
- `FetcherImpl.handleError` / `FetcherImpl.cancel` / `FetcherImpl.markClosed` / `FetcherState` (`src/fetcher.ts`。`markClosed` は公開インターフェース `Fetcher` には無い内部メソッド)
- `issues/closed/0557-bug-malformed-track-cross-cancel.md` (cross-cancel の導入)
- `issues/0575-bug-track-status-malformed-handling.md` (TRACK_STATUS_OK の malformed で cross-cancel を適用するかという別の論点。本 issue は fetcher のキャンセル中の二重通知のみを扱い、対象が異なる)
