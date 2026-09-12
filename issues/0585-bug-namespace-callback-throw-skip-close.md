# namespace 系ループの catch で error コールバックの例外が reject とセッションクローズを中断する

- Created: 2026-09-12
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-namespace-callback-throw-skip-close
- Polished: {YYYY-MM-DD}

## 目的

`src/session/namespaceLoops.ts` の 3 ループの catch は、アプリの `callbacks.error` を先に呼び、その後に保留 Promise の reject・保留中 REQUEST_UPDATE の reject・`session.closeWithError` を実行する。`callbacks.error` が throw すると catch 内の後続処理が中断され、確立前 Promise と `update()` が未解決のまま残り、プロトコル違反を検出してもセッションが閉じない。アプリコールバックの例外で終了手順が止まらないようにする。

## 現状

- `namespaceStartNamespaceStreamLoop` の catch は `callbacks.error?.(normalizedError)` を呼び、その後に `reject(normalizedError)` / `handleNamespaceRequestUpdateStreamClosed` / `toSessionCloseError` による `session.closeWithError` を実行する。`callbacks.error` が throw すると reject と close に到達しない。
- `namespaceStartTracksStreamLoop` / `namespaceStartPublicationStreamLoop` の catch も同じ順序で `callbacks.error` を呼び、reject と close に到達しない (Publication は保留中 REQUEST_UPDATE の処理を持たないため、影響は reject と close)。
- 同じ catch 内の `activeTracker.emitAll()` は `createNamespaceActiveTracker` がコールバック例外を握り潰す実装になっており、この問題はない。
- JavaScript では catch ブロック内で throw すると同一 catch では捕捉されず、`finally` を通過して呼び出し元へ伝播する。`SessionImpl.closeWithError` はアプリコールバックの throw を吸収して close を必ず実行するが、3 ループは `closeWithError` より前に `callbacks.error` を直接呼ぶため、この保護の外にある。
- 結果として、`callbacks.error` が throw すると (a) 確立前の `subscribeNamespace` / `subscribeTracks` 等の Promise が未解決のまま残り、(b) resolved 後の保留中 REQUEST_UPDATE の reject がスキップされ `update()` が未解決のまま残り、(c) プロトコル違反・`SessionError` (KEY_VALUE_FORMATTING_ERROR 等) を検出してもセッションが閉じない。

## 設計方針

1. 3 ループの catch で `callbacks.error` の throw を握り潰し、その後の reject・`handleNamespaceRequestUpdateStreamClosed`・`session.closeWithError` を必ず実行する。`createNamespaceActiveTracker.emitAll` と同じ「アプリのコールバック例外は握り潰す (後始末を止めない)」方針に揃える。
2. 握り潰した例外は他の経路と同様に黙殺する (プロトコル違反ではない)。デバッグ記録の要否は実装時に既存方針と揃える。
3. `finally` の state 更新・Map 削除・`releaseLock` は現状のまま維持する。
4. 3 ループそれぞれで、throw する `callbacks.error` を注入しても確立前 Promise の reject・セッションクローズ (Namespace / Tracks は保留中 REQUEST_UPDATE の reject も) が実行されるテストを追加する。
5. `issues/0577-refactor-namespace-loop-dedup.md` が 3 ループを共通化する予定であり、共通化後も本修正の趣旨が維持されるようにする。実装順は 0577 の状況に合わせて調整する。

## 完了条件

- 3 ループの catch で `callbacks.error` が throw しても、確立前 Promise の reject と `session.closeWithError` が実行されること。
- Namespace / Tracks ループでは、`callbacks.error` が throw しても resolved 後の保留中 REQUEST_UPDATE の reject が実行されること。
- セッションクローズ対象のエラー (SessionError / ProtocolViolationError / IncompleteDataError) で、throw する `callbacks.error` を注入してもセッションが閉じること。
- 上記を検証するテストがあること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- `namespaceStartNamespaceStreamLoop` / `namespaceStartTracksStreamLoop` / `namespaceStartPublicationStreamLoop` (`src/session/namespaceLoops.ts`)
- `createNamespaceActiveTracker` (`src/session/namespaceLoops.ts`。コールバック例外を握り潰す先例)
- `SessionImpl.closeWithError` (`src/session.ts`。コールバック throw の吸収)
- `issues/0577-refactor-namespace-loop-dedup.md` (3 ループ共通化)
