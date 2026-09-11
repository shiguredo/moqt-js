# namespace 確立後 REQUEST_UPDATE_OK の検証失敗で reject が汎用エラーになる

- Created: 2026-09-12
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-namespace-update-reject-order
- Polished: 2026-09-12

## 目的

`handleNamespaceRequestUpdateOk` はスコープ違反・Track Properties 違反のとき `session.closeWithError` を先に呼び、その後に `rejectPendingNamespaceUpdates` を呼ぶ。`closeWithError` が同期的に保留中の更新を汎用の "session closed" で reject するため、後続の `rejectPendingNamespaceUpdates` は対象がなく no-op になり、`update()` は意図した違反エラーではなく汎用エラーで失敗する。

## 現状

- `src/session/namespaceLoops.ts` の `handleNamespaceRequestUpdateOk` は、検証失敗時に `session.closeWithError(scopeError)` → `rejectPendingNamespaceUpdates(..., new Error("update failed: session closed with PROTOCOL_VIOLATION in REQUEST_UPDATE_OK"))` の順に呼ぶ。
- `SessionImpl.closeWithError` は `close()` を同期的に開始し、最初の await より前に `rejectPendingRequests(new Error("session closed"))` を実行して `pendingRequestUpdate` を空にする。
- そのため `rejectPendingNamespaceUpdates` は `hasPendingRequestUpdate` が false で早期 return し、`update()` には汎用の "session closed" が届く。
- テストはテスト用 session の `closeWithError` が記録のみのため、この差を検出できない。

## 設計方針

1. 検証失敗時は `rejectPendingNamespaceUpdates` を `closeWithError` より先に呼び、返却された `SessionError` を reject に渡す (既存の reject → close の順序に揃える)。
2. `pendingPrefix` などの保留状態の掃除が確実に行われることを確認する。
3. `src/session/namespaceLoops.test.ts` の `createNamespaceLoopTestContext` の `closeWithError` を本番相当 (保留中の更新を `new Error("session closed")` で reject する挙動) に変更し、既存 2 テストの `pending.rejected` の期待値を違反 `SessionError` 自体 (同一オブジェクト) に更新したうえで、同一性・メッセージ・`pendingPrefix` のクリアを検証するテストを追加する。

## 完了条件

- namespace 確立後 REQUEST_UPDATE_OK の検証失敗で、保留中の更新が違反 `SessionError` 自体で reject されること。
- 既存 2 テストの期待値が違反 `SessionError` に更新され、同一性・メッセージ・`pendingPrefix` のクリアを検証するテストがあること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。
- `CHANGES.md` の `## develop` に `[FIX]` を追加すること。

## 関連

- `handleNamespaceRequestUpdateOk` / `rejectPendingNamespaceUpdates` (`src/session/namespaceLoops.ts`)
- `createNamespaceLoopTestContext` (`src/session/namespaceLoops.test.ts`)
- `SessionImpl.closeWithError` / `rejectPendingRequests` (`src/session.ts`)
- `issues/closed/0523-refactor-namespace-validation-error.md`
