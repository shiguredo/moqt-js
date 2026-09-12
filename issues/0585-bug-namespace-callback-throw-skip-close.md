# namespace 系ループで error コールバックの例外が reject とセッションクローズを中断する

- Created: 2026-09-12
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-namespace-callback-throw-skip-close
- Polished: 2026-09-12

## 目的

`src/session/namespaceLoops.ts` の 3 ループは、アプリの `callbacks.error` を先に呼び、その後に保留 Promise の reject・保留中 REQUEST_UPDATE の reject・`session.closeWithError` を実行する箇所を持つ。対象は 3 ループの catch と、各ループの `case MessageType.REQUEST_ERROR:` 節 (確立前の初期 REQUEST_ERROR を通る経路) である。`callbacks.error` が throw すると後続処理が中断され、確立前 Promise と `update()` が未解決のまま残り、プロトコル違反を検出してもセッションが閉じない。アプリコールバックの例外で終了手順が止まらないようにする。

## 現状

- `namespaceStartNamespaceStreamLoop` の catch は `callbacks.error?.(normalizedError)` を呼び、その後に `reject(normalizedError)` / `handleNamespaceRequestUpdateStreamClosed` / `toSessionCloseError` による `session.closeWithError` を実行する。`callbacks.error` が throw すると reject と close に到達しない。
- `namespaceStartTracksStreamLoop` / `namespaceStartPublicationStreamLoop` の catch も同じ順序で `callbacks.error` を呼び、reject と close に到達しない (Publication は保留中 REQUEST_UPDATE の処理を持たないため、影響は reject と close)。
- 3 ループは catch 以外に `case MessageType.REQUEST_ERROR:` 節にも同じ順序の呼び出しを持つ (確立前の初期 REQUEST_ERROR を通る経路)。`subscription.state` (Publication は `publication.state`) を `"closed"` にしてから `callbacks.error` を呼び、その後に `reject(error)` を呼ぶ。`callbacks.error` が throw すると外側 catch に再流入するが、state が既に `"closed"` のため catch の `subscription.state === "active"` (Publication は `publication.state !== "closed"`) ガードが成立せず reject は実行されず、`toSessionCloseError` も null (アプリの例外は SessionError / ProtocolViolationError / IncompleteDataError ではない) のため close も起きない。
- 同じ catch 内の `activeTracker.emitAll()` は `createNamespaceActiveTracker` がコールバック例外を握り潰す実装になっており、この問題はない。
- JavaScript では catch ブロック内で throw すると同一 catch では捕捉されず、`finally` を通過して呼び出し元へ伝播する。`SessionImpl.closeWithError` はアプリコールバックの throw を吸収して close を必ず実行するが、3 ループは `closeWithError` より前に `callbacks.error` を直接呼ぶため、この保護の外にある。
- 確立前 Promise (`subscribeNamespace` / `subscribeTracks` / `publishNamespace`) は pending Map に登録されないため、`SessionImpl.close()` の `rejectPendingRequests` では救済されない。reject を失った Promise は、その後セッションが別経路で閉じても未解決のまま残る。
- 結果として、`callbacks.error` が throw すると (a) 確立前の `subscribeNamespace` / `subscribeTracks` / `publishNamespace` の Promise が未解決のまま残り、(b) resolved 後の保留中 REQUEST_UPDATE の reject がスキップされ `update()` が未解決のまま残り、(c) プロトコル違反・`SessionError` (KEY_VALUE_FORMATTING_ERROR 等) を検出してもセッションが閉じない。

## 設計方針

1. 3 ループの catch と `case MessageType.REQUEST_ERROR:` 節で `callbacks.error` の throw を握り潰し、その後の reject・`handleNamespaceRequestUpdateStreamClosed`・`session.closeWithError` を必ず実行する。`createNamespaceActiveTracker.emitAll` と同じ「アプリのコールバック例外は握り潰す (後始末を止めない)」方針に揃える。呼び出し順序は現状のまま (通知が先、後始末が後) とし、`runPublishStreamSubLoop` の「reject を通知より前に置く」方式へは寄せない。
2. 「必ず」は既存の実行条件を無条件化する意味ではない。`subscription.state === "active"` / `!goawayReceived` / `!resolved && !requestMigrated` / `resolved` / `toSessionCloseError(error) !== null` の各ガードと、namespace / tracks の `isSessionClosedError` による通知抑止は現状のまま維持し、`callbacks.error` の throw に影響されないことを指す。
3. 握り潰した例外は再 throw せず、ここではデバッグ記録も行わない。namespace 系ループの既存のアプリコールバック例外の扱い (`createNamespaceActiveTracker.emitAll` / `namespaceHandleGoaway` は黙殺する) に揃える。3 ループが呼ぶのは購読単位の `callbacks.error` (`NamespaceSubscriptionCallbacks` / `TracksSubscriptionCallbacks` / `NamespacePublicationCallbacks`) であり、`SessionImpl.closeWithError` が debug 記録の対象にするセッション単位の `ConnectCallbacks.error` とは別系統である。close 対象エラーの catch 経路では、後続の `session.closeWithError` がセッション単位の通知とその throw の記録を担う。
4. `finally` の state 更新・Map 削除・`releaseLock` は現状のまま維持する。
5. 3 ループそれぞれで、throw する `callbacks.error` を注入したテストを追加する。検証対象は (a) catch 経路: 実行条件を満たすときの確立前 Promise の reject、resolved 後の保留中 REQUEST_UPDATE の reject (Namespace / Tracks)、セッションクローズ対象エラーのときの `session.closeWithError`、(b) `REQUEST_ERROR` 経路: 確立前 Promise の reject。テストは実 `ReadableStream` / 実 Map の既存ハーネス (`createNamespaceLoopTestContext` と publication 用ハーネス) に `callbacks.error` を注入する形にし、モック・スタブは使わない。
6. 本 issue を `issues/0577-refactor-namespace-loop-dedup.md` より先に実施する (0577 は未着手の refactor)。0577 の共通化後も本修正の趣旨が維持されるようにする。0577 の完了条件は「既存テストが全て通り、テストの検証内容が変わらないこと」であり、本 issue で追加するテストが共通ループでも通ることが保護の維持条件になる。

## 完了条件

- 3 ループの catch で `callbacks.error` が throw しても、実行条件を満たすときの確立前 Promise の reject が実行されること。
- 3 ループの `REQUEST_ERROR` 節で `callbacks.error` が throw しても、確立前 Promise の reject が実行されること。
- Namespace / Tracks ループの catch で、`callbacks.error` が throw しても resolved 後の保留中 REQUEST_UPDATE の reject が実行されること。
- セッションクローズ対象のエラー (SessionError / ProtocolViolationError / IncompleteDataError) で、throw する `callbacks.error` を注入してもセッションが閉じること。
- 上記を検証するテストがあること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- `namespaceStartNamespaceStreamLoop` / `namespaceStartTracksStreamLoop` / `namespaceStartPublicationStreamLoop` (`src/session/namespaceLoops.ts`)
- `namespaceHandleGoaway` / `createNamespaceActiveTracker` (`src/session/namespaceLoops.ts`。コールバック例外を握り潰す先例)
- `SessionImpl.closeWithError` (`src/session.ts`。コールバック throw の吸収)
- `SessionImpl.markRequestObjectsClosed` / `SessionImpl.rejectPendingRequests` (`src/session.ts`。確立前 Promise が close では reject されないことの根拠)
- `runPublishStreamSubLoop` (`src/session.ts`。reject を通知より前に置く先例)
- `src/session/namespaceLoops.test.ts` (実ストリーム・実 Map のテストハーネス)
- `issues/0577-refactor-namespace-loop-dedup.md` (3 ループ共通化)
- `issues/closed/0442-bug-close-with-error-callback-throw.md` (closeWithError のコールバック throw 吸収を追加した先行 issue)
