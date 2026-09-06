# SUBSCRIBE / FETCH / TRACK_STATUS の応答スコープ違反で具体エラーが失われる

- Created: 2026-09-06
- Completed: YYYY-MM-DD
- Branch: feature/fix-response-scope-error-loss
- Polished: 2026-09-06

## 目的

応答のパラメータスコープ違反時に `pending` の `reject` と削除を行わず、汎用 close エラーに埋もれる。原因特定のため具体エラーで `reject` する必要がある。

## 現状

- `src/session/bidi.ts` の `bidiReadSubscribeResponse` / `bidiReadFetchResponse` / `bidiReadTrackStatusResponse` はスコープ検証失敗で `session.closeWithError` 後に `return` するだけである。
- ハングはしない (後の `close` で汎用エラーが reject される) が、PUBLISH 経路が具体エラーを保持して `reject` するのと不整合である。

## 設計方針

1. 3 経路とも PUBLISH 経路と同一パターンに揃える。各経路の既存失敗経路と同一の削除集合 (SUBSCRIBE は `pendingSubscribe` + `requestStreams` + `fillFetchTargets` の 3 件、FETCH は `pendingFetch` + `requestStreams`、TRACK_STATUS は `pendingTrackStatus` + `requestStreams`) で削除し、同一 `SessionError` オブジェクトで `pending.reject` してから `session.closeWithError` する (順序固定)。

(4 応答読み取りの定型処理の共通化は `0498` に委ね、本 issue では行わない。)

## 完了条件

- 3 経路のスコープ違反で具体エラーが `reject` され、各経路の削除集合が掃除されること。`reject` される値は `closeWithError` に渡す `SessionError` と同一オブジェクトであり、`reject` してから閉じる順序であること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 関連

- `0498` (4 応答読み取りの共通化。重複整理はそちらに委ねる)
