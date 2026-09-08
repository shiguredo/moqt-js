# FETCH 失敗確定時に待機中の fetcher 取得を起こす

- Created: 2026-09-07
- Completed: 2026-09-08
- Branch: feature/fix-fetch-failure-wakeup
- Polished: 2026-09-08

## 目的

FETCH が失敗確定しても待機中の取得が最大 5 秒停滞する。失敗確定時に起こして即時解決する必要がある。

## 現状

- `src/session/bidi.ts` の `bidiReadFetchResponse` で待機者を起こすのは FETCH_OK 成功時のみであり、REQUEST_ERROR / GOAWAY / 想定外型 / FIN 先行時は起こさず `fetcherReadyCallbacks` の登録も残る。
- `bidiCancelFetch`（`src/session/bidi.ts`）は確立済みの `FetcherImpl` を受け取るため FETCH_OK 前の待機者とは排他的であり、本 issue の対象外とする。
- FETCH_OK よりデータストリームが先着して待機中の場合、失敗確定後も自前タイマーまで解決せず、その間は当該ストリームのハンドラが止まる。セッション終了時は起こされるため最終的な漏れにはならない。

## 設計方針

1. 失敗確定経路（REQUEST_ERROR / GOAWAY / 想定外型 / FIN 先行）で当該要求の待機コールバックを発火して `fetcherReadyCallbacks` の登録を削除する。成功経路の無名インラインループを共通ヘルパーに切り出して使う。待機の解決値は成功経路と同様に `fetchers` 不在のため `null` になる。`pendingFetch` / `requestStreams` の掃除は各経路の既存削除に従い、本 issue では待機解除のみを追加する。

## 完了条件

- 失敗確定時に待機が `null` で即時解決し、`fetcherReadyCallbacks` の登録が残らないこと（対象は REQUEST_ERROR / GOAWAY / 想定外型 / FIN 先行）。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 解決方法

- `src/session/bidi.ts` に `fireFetcherReadyCallbacks` を追加し、成功経路の発火を共通化して失敗 6 箇所で使う。`pendingFetch` / `requestStreams` の掃除は既存削除に従う
- `src/session/bidi.test.ts` に待機即時解決 7 件のテストを追加した
- `CHANGES.md` の `## develop` に `[FIX]` を追記した

## 関連

- draft-ietf-moq-transport-20 §5.2 / §10.13 / §10.14 / §3.3.2
