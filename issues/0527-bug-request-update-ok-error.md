# REQUEST_UPDATE_OK スコープ違反の具体エラーが失われる

- Created: 2026-09-07
- Completed: YYYY-MM-DD
- Branch: feature/fix-request-update-ok-error
- Polished: 2026-09-08

## 目的

確立済み購読上の REQUEST_UPDATE_OK の検証違反で `update()` の呼び出し元が汎用エラーしか受け取れない。初期応答 4 経路（PUBLISH / SUBSCRIBE / FETCH / TRACK_STATUS）と同様に具体エラーで `reject` する必要がある。

## 現状

- `src/session/bidi.ts` の `bidiHandleRequestUpdateOk` は `REQUEST_UPDATE_OK` のパラメータスコープ検証と Track Properties 空検証のいずれも、違反時に `closeWithError` のみ行い、保留中の更新を特定エラーで `reject` しない。
- 呼び出し元はセッション終了時の汎用エラーで解決され、特定の違反文言が失われる。
- 成功 `REQUEST_UPDATE_OK` は §10.9.1 で 1 更新に 1 `REQUEST_OK` が MUST であり、1 対 N になるのは失敗 `REQUEST_ERROR` の coalescing のみである。違反によるセッション終了時は保留全件の `reject` が必要になる。

## 設計方針

1. パラメータスコープ検証と Track Properties 空検証のいずれの違反でも、当該購読の保留分全件を違反 `SessionError` 自体で `reject` してから閉じる。`REQUEST_ERROR` 時の coalescing 処理と同様に `deleteFillTargetsForPendingUpdates` と `rejectPendingRequestUpdates` の 2 点組で行う。順序は scope 違反の捕捉→削除→`reject`→`close` とし（先に閉じると汎用 reject で上書きされるためコールバック遅延化する）、初期応答 4 経路のパターンに合わせる。`namespaceLoops.ts` の更新応答検証は既に両経路で `reject` 済みのため動作は一致させるが、エラー同一性は初期応答経路に合わせ（違反自体を渡す）、`namespaceLoops.ts` 側のラッパー `Error` には合わせない。

## 完了条件

- 検証違反で保留中の更新全件が違反 `SessionError` 自体で `reject` され、fill 関連付けも掃除されること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 関連

- draft-ietf-moq-transport-20 §10.2.1 / §10.5 / §10.9.1
