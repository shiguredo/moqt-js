# malformed 検出の重複で fetcher の error コールバックが二重発火する

- Created: 2026-09-12
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-fetcher-double-error-notify
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-transport-21 §12.1 は malformed Track の検出時に購読 / FETCH を cancel し、アプリへ error を通知することを求める (SHOULD)。現状の `cancelMalformedTrackPeers` は fetcher の error コールバックが二重に呼ばれ得る窓があり、同一の malformed 検出が重なるとアプリが同じエラーを 2 回受け取る。

## 現状

- `src/session/bidi.ts` の `cancelMalformedTrackPeers` は `fetcher.handleError(error)` を呼んでから `void fetcher.cancel()` を呼ぶ。
- `src/fetcher.ts` の `FetcherImpl.handleError` は `state === "closed"` のときだけ抑止し、呼び出しでは state を変えない。
- `FetcherImpl.cancel` が state を closed にするのは `await this.onCancel()` の完了後であり、実運用の `bidiCancelFetch` では `await streamInfo.stream.readable.cancel(...)` の後になる。
- `bidiCancelFetch` が `session.fetchers` からエントリを削除するのも同じ await の後である。この間、同一 fetcher は active のまま Map に残るため、別経路の malformed 検出が重なると `handleError` が再度呼ばれ、error コールバックが 2 回呼ばれ得る。
- 購読側は `bidiCancelSubscriptionWithError` が同期区間で `markClosed` するため二重通知しない。

## 設計方針

1. `FetcherImpl` にキャンセル中を表す状態を追加し、`handleError` / `handleObject` がキャンセル開始時点で通知・配信を止める。または `cancelMalformedTrackPeers` から `bidiCancelFetch` を直接呼び、キャンセル開始と state 更新を同期化する。
2. 重複する malformed 検出でも error コールバックが 1 回だけ呼ばれることを検証するテストを追加する。

## 完了条件

- 同一 fetcher に対して malformed 検出が重複しても error コールバックが 1 回だけ呼ばれること。
- 上記を検証するテストがあること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。
- `CHANGES.md` の `## develop` に `[FIX]` を追加すること。

## 関連

- draft-ietf-moq-transport-21 §12.1
- `cancelMalformedTrackPeers` (`src/session/bidi.ts`)
- `FetcherImpl.handleError` / `FetcherImpl.cancel` / `FetcherImpl.markClosed` (`src/fetcher.ts`)
- `bidiCancelFetch` (`src/session/bidi.ts`)
- `issues/closed/0557-bug-malformed-track-cross-cancel.md` (cross-cancel の導入)
