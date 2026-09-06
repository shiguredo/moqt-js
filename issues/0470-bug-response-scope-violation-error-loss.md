# SUBSCRIBE / FETCH / TRACK_STATUS の応答スコープ違反で具体エラーが失われる

- Created: 2026-09-06
- Completed: YYYY-MM-DD
- Branch: feature/fix-response-scope-error-loss
- Polished: YYYY-MM-DD

## 目的

応答のパラメータスコープ違反時に `pending` の `reject` と削除を行わず、汎用 close エラーに埋もれる。原因特定のため具体エラーで `reject` する必要がある。

## 現状

- `src/session/bidi.ts` の `bidiReadSubscribeResponse` / `bidiReadFetchResponse` / `bidiReadTrackStatusResponse` はスコープ検証失敗で `session.closeWithError` 後に `return` するだけである。
- ハングはしない (後の `close` で汎用エラーが reject される) が、PUBLISH 経路が具体エラーを保持して `reject` するのと不整合である。

## 設計方針

1. 3 経路とも PUBLISH 経路と同一パターン (具体エラーを保持して `pending.reject` してから閉じる) に揃える。
2. 4 応答読み取りの定型処理の共通化も検討する (重複は別途整理対象のため本 issue では 3 経路の修正に留める)。

## 完了条件

- 3 経路のスコープ違反で具体エラーが `reject` されること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。
