# REQUEST_UPDATE_OK スコープ違反の具体エラーが失われる

- Created: 2026-09-07
- Completed: YYYY-MM-DD
- Branch: feature/fix-request-update-ok-error
- Polished: YYYY-MM-DD

## 目的

確立済み購読上の REQUEST_UPDATE_OK のスコープ違反で `update()` の呼び出し元が汎用エラーしか受け取れない。初期応答 3 経路と同様に具体エラーで `reject` する必要がある。

## 現状

- `src/session/bidi.ts` の `bidiHandleRequestUpdateOk` は `REQUEST_UPDATE_OK` のスコープ違反で `closeWithError` のみ行い、保留中の更新を特定エラーで `reject` しない。
- 呼び出し元はセッション終了時の汎用エラーで解決され、特定の違反文言が失われる。
- coalescing（§10.9）により複数の更新が 1 応答に対応し得るため、1 対 1 対応ではない点の設計判断が必要である。

## 設計方針

1. `REQUEST_ERROR` 時の coalescing 処理と同様に、当該購読の保留分を特定違反で `reject` してから閉じる。`namespaceLoops.ts` の更新応答スコープ検証との整合性も確認する。

## 完了条件

- スコープ違反で保留中の更新が具体エラーで `reject` されること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 関連

- draft-ietf-moq-transport-20 §10.2.1 / §10.9
