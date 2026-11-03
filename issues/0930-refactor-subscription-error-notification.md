# namespace / tracks 購読でリクエスト単位とセッション単位の error が重複して通知される

- Created: 2026-11-03
- Completed: {YYYY-MM-DD}
- Branch: feature/refactor-subscription-error-notification
- Polished: {YYYY-MM-DD}

## 目的

`Session.subscribeNamespace()` / `Session.subscribeTracks()` の読み取りループは、`isSessionClosedError` のときだけリクエスト単位の `error` コールバックを抑止する。`ProtocolViolationError` / `IncompleteDataError` のようにライブラリがセッションを閉じる原因でも、リクエスト単位の `error` と `ConnectCallbacks.error` の両方が通知される。publication は 0889 で `toSessionCloseError` に揃えたため、購読系だけ非対称である。高レベル API は購読のリクエスト単位 `error` を `onError` に流すため、将来これらのループを高レベル API が使うと同じ二重通知が再発し得る。

## 現状

- `src/session/namespaceLoops.ts` の `namespaceHandleSubscriptionReadError` は `if (!isSessionClosedError(error))` のときだけ `namespaceNotifyError` を呼ぶ
- `isSessionClosedError` は WebTransport の `source === "session"` だけを判定し、`toSessionCloseError` (SessionError / ProtocolViolationError / IncompleteDataError) とは判定対象が違う
- publication の `onReadError` は `toSessionCloseError(error) === null` のとき通知する
- `src/session/bidi.ts` の `handleRequestStreamReadError` は `toSessionCloseError` で早期 return する
- `src/session/publicTypes.ts` の `NamespaceSubscriptionCallbacks.error` / `TracksSubscriptionCallbacks.error` は、セッションを閉じるプロトコル違反でも呼ばれ `ConnectCallbacks.error` と重複し得る旨を明記している
- `issues/0893-refactor-subscriber-announcement-cleanup.md` は購読と namespace 告知の実装の整理を扱うが、通知条件の統一は含まない

## 設計方針

購読系の通知条件を `toSessionCloseError` に揃え、publication / bidi と同一規則にする。セッションを閉じる原因ではリクエスト単位の `error` を呼ばず、`ConnectCallbacks.error` だけが通知する。抑止しても `ctx.reject(error)` は維持する (未確立の待ちを具体的なエラーで settle させる)。

契約を変えるため、`src/session/publicTypes.ts` の JSDoc と `docs/LOW_LEVEL_API.md` の記述を更新する。`src/session/namespaceLoops.test.ts` の `LOOP_CASES` の `errorNotificationCount` を namespace / tracks も 0 に更新する。

## 完了条件

- 購読系のリクエスト単位 `error` が、ライブラリが `closeWithError` でセッションを閉じる原因では呼ばれない
- セッションを閉じない読み取りエラー (ピアの `RESET_STREAM` など) では従来どおり通知する
- `ctx.reject(error)` の経路を維持する
- 契約を `src/session/publicTypes.ts` と `docs/LOW_LEVEL_API.md` に記述する
- `src/session/namespaceLoops.test.ts` で通知回数と reject を固定する
- `vp check` と `vp test --run` が通る

`CHANGES.md` は MOQT RFC ドラフト中のため更新しない (`CODEBASE.md` の特別ルール)。

## 参照

- `src/session/namespaceLoops.ts` の `namespaceHandleSubscriptionReadError` / `createPublicationStreamHandlers` の `onReadError` / `namespaceNotifyError`
- `src/session/errors.ts` の `isSessionClosedError` / `toSessionCloseError`
- `src/session/bidi.ts` の `handleRequestStreamReadError`
- `src/session/publicTypes.ts` の `NamespaceSubscriptionCallbacks` / `TracksSubscriptionCallbacks` / `NamespacePublicationCallbacks`
- `src/session/namespaceLoops.test.ts` の `LOOP_CASES`
- docs/LOW_LEVEL_API.md の「Namespace 系の扱い」
