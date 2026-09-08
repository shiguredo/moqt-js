# FETCH データストリームの reset で fetcher state を破棄する

- Created: 2026-09-08
- Completed: YYYY-MM-DD
- Branch: feature/fix-fetch-reset-state-cleanup
- Polished: 2026-09-08

## 目的

draft-ietf-moq-transport-20 §5.2 は「A subscriber keeps FETCH state until it cancels the request ..., receives REQUEST_ERROR, or the FETCH data stream receives a FIN or is reset.」と定める。現状はピアの RESET_STREAM で fetcher state が破棄されず、アプリに終了も通知されない。

## 現状

- `src/session.ts` の FETCH データストリーム処理の catch は、`toProtocolViolationSessionError` が非 null のときセッションを閉じ、`MalformedTrackError` のとき `handleMalformedFetchTrack` を呼ぶ。
- ピアの RESET_STREAM は `WebTransportError(source: "stream")` になり、`isPeerStreamError` が真、`toProtocolViolationSessionError` が null、`MalformedTrackError` でもないため、どの分岐にも該当せず `fetcher.handleEnd()` / `fetchers.delete()` / エラー通知が行われない。
- 結果として `fetchers` Map にエントリが残留し、アプリは fetch の終了を検知できない。
- `FetcherImpl.handleError` は `fetcherState === "closed"` のとき早期 return するため、通知より先に closed にすると通知が握り潰される。既存の `handleMalformedFetchTrack` は `handleError` を `cancel` より前に呼び、通知してから閉じる。既存の reset エラー組み立て `createResetStreamError`（`src/session/bidi.ts`）は固定文言 `publisher reset request stream` を使うため、FETCH データストリームの reset にそのまま使うと対象を誤って伝える。

## 設計方針

1. FETCH データストリーム処理で peer 起因の stream error（`isPeerStreamError`）を検出したら、**通知を先に**行い、その後 closed にして `fetchers` から削除する。`fetcher.handleError(error)` を `markClosed` / `cancel` より前に呼ぶ既存パターンに合わせる。
2. 通知する Error には、正規化した `streamErrorCode` を載せる。メッセージは bidi リクエストストリーム用の `publisher reset request stream` を流用せず、FETCH データストリームの reset であることが分かる文言にする。`streamErrorCode` の正規化（`normalizeDataStreamErrorCode`）は再利用する。
3. FIN 経路と reset 経路で state 破棄の集合を揃え、孤児エントリを残さない。
4. ピア reset で fetcher が通知され、state が closed になり、`fetchers` から削除されるテストを追加する。

## 完了条件

- FETCH データストリームの peer reset で、アプリの error コールバックが 1 回だけ呼ばれること。
- 通知 Error に正規化済み `streamErrorCode` が載り、メッセージが FETCH データストリームの reset であることを示すこと。
- `fetcher.state` が `"closed"` になり、`fetchers` からエントリが削除されること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 関連

- draft-ietf-moq-transport-20 §5.2 / §3.3.3 / §3.3.4
- `FetcherImpl` / `handleMalformedFetchTrack`（`src/session.ts`）
- `fetchers` / `isPeerStreamError` / `normalizeDataStreamErrorCode`
- `createResetStreamError`（`src/session/bidi.ts`、文言流用の可否）
