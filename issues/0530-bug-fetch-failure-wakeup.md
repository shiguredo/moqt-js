# FETCH 失敗確定時に待機中の fetcher 取得を起こす

- Created: 2026-09-07
- Completed: YYYY-MM-DD
- Branch: feature/fix-fetch-failure-wakeup
- Polished: YYYY-MM-DD

## 目的

FETCH が失敗確定しても待機中の取得が最大 5 秒停滞する。失敗確定時に起こして即時解決する必要がある。

## 現状

- `src/session/bidi.ts` の `bidiReadFetchResponse` で待機者を起こすのは FETCH_OK 成功時のみであり、REQUEST_ERROR / GOAWAY / 想定外型 / FIN 先行時は起こさず登録も残る。
- `bidiCancelFetch`（`src/session/bidi.ts`）も待機者を起こさない。
- FETCH_OK よりデータストリームが先着して待機中の場合、失敗確定後も自前タイマーまで解決せず、その間は受信処理が止まる。セッション終了時は起こされるため最終的な漏れにはならない。

## 設計方針

1. 失敗確定経路（REQUEST_ERROR / GOAWAY / FIN / cancel）で当該要求の待機コールバックを発火して登録を削除する。成功経路と同一の発火処理を使う。

## 完了条件

- 失敗確定時に待機が即時解決すること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 関連

- draft-ietf-moq-transport-20 §10.9 / §3.3.2
