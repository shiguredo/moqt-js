# namespace 系の初期応答検証失敗で Promise が永久ハングする

- Created: 2026-09-06
- Completed: YYYY-MM-DD
- Branch: feature/fix-namespace-first-response-hang
- Polished: YYYY-MM-DD

## 目的

`subscribeNamespace` / `subscribeTracks` / `publishNamespace` が返す `Promise` が、ピアの初期応答が仕様違反だった場合に永久に settle せず、アプリが応答待ちで停止する。確立前の検証失敗は `reject` で呼び出し元に返す必要がある。

## 現状

- `src/session/namespaceLoops.ts` の 3 受信ループ (`namespaceStartNamespaceStreamLoop` / `namespaceStartTracksStreamLoop` / publication ループ) は、確立前の先頭メッセージ検証 (`namespaceValidateFirstMessage`) や `REQUEST_OK` のスコープ検証・Track Properties 非空検証の失敗時に `session.closeWithError` のみ呼んで `return` し、`reject` を呼ばない。
- `throw` されないため `catch` の `reject` 経路にも載らず、`finally` は state 掃除のみである。
- `bidi.ts` の PUBLISH 応答経路は `pending.reject` してから閉じる対照パターンであり、不整合である。

## 設計方針

1. 確立前の全検証失敗経路で `reject` してから `session.closeWithError` する (PUBLISH 経路と同一パターン)。
2. 3 ループ共通のヘルパーに寄せ、将来の抜けを防ぐ。

## 完了条件

- 確立前の検証失敗で呼び出し元の `Promise` が `reject` されること (3 API とも)。
- 正常系の確立フローが変わらないこと。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。
