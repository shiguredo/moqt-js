# 応答読み取り失敗経路の削除集合を統一する

- Created: 2026-09-07
- Completed: YYYY-MM-DD
- Branch: feature/fix-response-cleanup-sets
- Polished: 2026-09-08

## 目的

応答読み取りの失敗経路ごとに削除集合がばらつき、孤児の要求情報がセッション寿命まで残る。既存の統一済み経路に揃える必要がある。

## 現状

- `src/session/bidi.ts` の `bidiReadSubscribeResponse` の DUPLICATE_TRACK_ALIAS 経路は `pendingSubscribe` のみ削除し、`requestStreams` と `fillFetchTargets` を残す。
- `bidiReadFetchResponse` の End Location 検証経路は `pendingFetch` のみ削除し、`requestStreams` を残す。
- `bidiReadSubscribeResponse`、`bidiReadFetchResponse`、`bidiReadTrackStatusResponse` の 3 応答読み取りの汎用 catch の else 分岐（非プロトコル違反時）は `pending.reject` のみ行い、マップ掃除をしない。PUBLISH 経路は同種分岐で `pendingPublish` と `requestStreams` を削除するため非対称である。
- いずれもセッション終了時に回収される有界リークだが、同一関数の他分岐と非対称である。

## 設計方針

1. 各経路を同一関数の既存失敗経路と同じ削除集合に揃える。`bidiReadSubscribeResponse` の DUPLICATE_TRACK_ALIAS 経路は `pendingSubscribe` + `requestStreams` + `fillFetchTargets` の 3 件に揃える。`bidiReadFetchResponse` の End Location 検証経路は `pendingFetch` + `requestStreams` の 2 件に揃える。3 応答読み取り（`bidiReadSubscribeResponse`、`bidiReadFetchResponse`、`bidiReadTrackStatusResponse`）の汎用 catch の else 分岐は各関数の既存失敗経路と同じ集合に揃える（SUBSCRIBE は 3 件、FETCH と TRACK_STATUS は各 pending + `requestStreams` の 2 件）。

## 完了条件

- 上記 5 箇所の失敗経路の削除集合が同一関数内の既存失敗経路と一致し、失敗後に当該要求の entry が各マップに残らないこと。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 関連

- draft-ietf-moq-transport-20 §11.1（DUPLICATE_TRACK_ALIAS の根拠）
