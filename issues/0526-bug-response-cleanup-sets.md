# 応答読み取り失敗経路の削除集合を統一する

- Created: 2026-09-07
- Completed: YYYY-MM-DD
- Branch: feature/fix-response-cleanup-sets
- Polished: YYYY-MM-DD

## 目的

応答読み取りの失敗経路ごとに削除集合がばらつき、孤児の要求情報がセッション寿命まで残る。既存の統一済み経路に揃える必要がある。

## 現状

- `src/session/bidi.ts` の DUPLICATE_TRACK_ALIAS 経路は `pendingSubscribe` のみ削除し、`requestStreams` と `fillFetchTargets` を残す。
- `bidiReadFetchResponse` の End Location 検証経路は `pendingFetch` のみ削除し、`requestStreams` を残す。
- 3 応答読み取りの汎用 catch の else 分岐（非プロトコル違反時）は `pending.reject` のみ行い、マップ掃除をしない。PUBLISH 経路は同種分岐で削除するため非対称である。
- いずれもセッション終了時に回収される有界リークだが、同一関数の他分岐と非対称である。

## 設計方針

1. 各経路を同一関数の既存失敗経路と同じ削除集合に揃える（SUBSCRIBE は 3 件、FETCH は 2 件、汎用 catch は PUBLISH 型の掃除）。

## 完了条件

- 失敗経路の削除集合が同一関数内で統一されること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 関連

- draft-ietf-moq-transport-20 §10.2.1
