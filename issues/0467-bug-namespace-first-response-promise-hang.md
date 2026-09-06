# namespace 系の初期応答検証失敗で Promise が永久ハングする

- Created: 2026-09-06
- Completed: YYYY-MM-DD
- Branch: feature/fix-namespace-first-response-hang
- Polished: 2026-09-06

## 目的

`subscribeNamespace` / `subscribeTracks` / `publishNamespace` が返す `Promise` が、ピアの初期応答が仕様違反だった場合に永久に settle せず、アプリが応答待ちで停止する。確立前の検証失敗は `reject` で呼び出し元に返す必要がある。

## 現状

- `src/session/namespaceLoops.ts` の 3 受信ループは、確立前の検証失敗時に `session.closeWithError` のみ呼んで `return` し、`reject` を呼ばない。内訳は、`namespaceStartNamespaceStreamLoop` と `namespaceStartTracksStreamLoop` の先頭メッセージ検証 (`namespaceValidateFirstMessage`) 失敗、初期 `REQUEST_OK` のスコープ検証失敗 (3 ループとも)、Track Properties 非空検証の失敗 (`namespaceStartNamespaceStreamLoop` と publication ループの初期 `REQUEST_OK` のみ)、publication ループの想定外先頭メッセージ (`default` 節) である。`namespaceStartTracksStreamLoop` の初期 `REQUEST_OK` に Track Properties 非空検証はなく、§10.5 の空必須対象 (`SUBSCRIBE_NAMESPACE_OK` 等) に `SUBSCRIBE_TRACKS_OK` を含まないため新設しない。
- `throw` されないため `catch` の `reject` 経路にも載らず、`finally` は state 掃除のみである。
- `bidi.ts` の PUBLISH 応答経路は `pending.reject` してから閉じる対照パターンであり、不整合である。

## 設計方針

1. 確立前の全検証失敗経路で `reject` してから `session.closeWithError` する (PUBLISH 経路と同一パターン。`reject` する `SessionError` と同一オブジェクトを `closeWithError` に渡す)。新規の検証は追加しない。
2. 3 ループ共通のヘルパーに寄せ、将来の抜けを防ぐ。

## 完了条件

- 確立前の検証失敗で呼び出し元の `Promise` が `reject` されること (3 API とも)。`reject` される値は `closeWithError` に渡す `SessionError` と同一オブジェクトであること。
- 正常系の確立フローが変わらないこと。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。
