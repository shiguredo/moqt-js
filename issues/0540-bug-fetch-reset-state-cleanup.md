# FETCH データストリームの reset で fetcher state を破棄する

- Created: 2026-09-08
- Completed: YYYY-MM-DD
- Branch: feature/fix-fetch-reset-state-cleanup
- Polished: YYYY-MM-DD

## 目的

draft-ietf-moq-transport-20 §5.2 は「A subscriber keeps FETCH state until it cancels the request ..., receives REQUEST_ERROR, or the FETCH data stream receives a FIN or is reset.」と定める。現状はピアの RESET_STREAM で fetcher state が破棄されず、アプリに終了も通知されない。

## 現状

- `src/session.ts` の FETCH データストリーム処理の catch は、`toProtocolViolationSessionError` が非 null のときセッションを閉じ、`MalformedTrackError` のとき `handleMalformedFetchTrack` を呼ぶ。
- ピアの RESET_STREAM は `WebTransportError(source: "stream")` になり、どちらの分岐にも該当しないため、`fetcher.handleEnd()` / `fetchers.delete()` / エラー通知が行われない。
- 結果として `fetchers` Map にエントリが残留し、アプリは fetch の終了を検知できない。

## 設計方針

1. FETCH データストリーム処理で peer 起因の stream error（`isPeerStreamError`）を検出したら、当該 fetcher を closed にして `fetchers` から削除し、既存の reset エラー通知方針（`streamErrorCode` の正規化を含む）に従ってアプリへ通知する。
2. FIN 経路と reset 経路で state 破棄の集合を揃え、孤児エントリを残さない。
3. ピア reset で fetcher state が破棄され、通知されるテストを追加する。

## 完了条件

- FETCH データストリームの peer reset で `fetchers` からエントリが削除されること。
- アプリの error コールバックが 1 回だけ呼ばれること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 関連

- draft-ietf-moq-transport-20 §5.2 / §3.3.3 / §3.3.4
- `FetcherImpl`
- `fetchers` / `isPeerStreamError` / `handleMalformedFetchTrack`
