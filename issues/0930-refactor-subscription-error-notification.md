# namespace / tracks 購読でリクエスト単位とセッション単位の error が重複して通知される

- Created: 2026-11-03
- Completed: {YYYY-MM-DD}
- Branch: feature/refactor-subscription-error-notification
- Polished: 2026-11-15
- Refreshed: 2026-11-14

## 目的

`Session.subscribeNamespace()` / `Session.subscribeTracks()` の読み取りループは、`isSessionClosedError` のときだけリクエスト単位の `error` コールバックを抑止する。`ProtocolViolationError` / `IncompleteDataError` のようにライブラリがセッションを閉じる原因でも、リクエスト単位の `error` と `ConnectCallbacks.error` の両方が通知される。publication は 0889 で `toSessionCloseError` に揃えたため、購読系だけ非対称である。高レベル API はリクエスト単位の `error` を `onError` に流すため、将来 `subscribeNamespace()` / `subscribeTracks()` を高レベル API が使うと同じ二重通知が再発し得る。

## 現状

- `src/session/namespaceLoops.ts` の `namespaceHandleSubscriptionReadError` は `if (!isSessionClosedError(error))` のときだけ `namespaceNotifyError` を呼ぶ
- `src/session/errors.ts` の `isSessionClosedError` は、グローバルに `WebTransportError` があり、かつエラーがそのインスタンスのときは `source === "session"` を判定する。それ以外 (グローバルが無い Node のテスト環境と、実ブラウザでも `WebTransportError` でないエラー) は、メッセージ (`"session is closed"` / `"session closed"` を含むか) で判定する。`toSessionCloseError` (SessionError / ProtocolViolationError / IncompleteDataError) とは判定対象が違う
- publication の `onReadError` は `!isSessionClosedError(error)` かつ `toSessionCloseError(error) === null` のとき通知する
- `src/session/bidi.ts` の `handleRequestStreamReadError` は `toSessionCloseError` で早期 return する
- `src/session/publicTypes.ts` の `NamespaceSubscriptionCallbacks.error` / `TracksSubscriptionCallbacks.error` は、セッションを閉じるプロトコル違反でも呼ばれ `ConnectCallbacks.error` と重複し得る旨を明記している
- `issues/closed/0893-refactor-subscriber-announcement-cleanup.md` は購読と namespace 告知の実装の整理を扱うが、通知条件の統一は含まない

## 設計方針

購読系の通知条件に `toSessionCloseError` の条件を加え、セッションを閉じる原因を通知しない点を publication / bidi と揃える。既存の `isSessionClosedError` の抑止は残す (置き換えない。publication 側にも同じ抑止を加えた closed の 0927 と揃える)。セッションを閉じる原因ではリクエスト単位の `error` を呼ばず、`ConnectCallbacks.error` だけが通知する。抑止しても `ctx.reject(error)` は維持する (未確立の待ちを具体的なエラーで settle させる)。

契約を変えるため、`src/session/publicTypes.ts` の JSDoc と `docs/LOW_LEVEL_API.md` の記述を更新する。`docs/LOW_LEVEL_API.md` の「Namespace 系の扱い」では、`subscribeTracks()` の `error` の項目を更新し、`subscribeNamespace()` の `error` も同じ条件であることを記す (詳細は各 JSDoc を正本とする)。`src/session/namespaceLoops.ts` の `namespaceNotifyError` の JSDoc にある「publication ループはセッションを閉じる原因や GOAWAY 受信後には呼ばない」という記述も、購読系を含む呼び出し条件に合わせて更新する。`namespaceHandleSubscriptionReadError` の JSDoc と通知条件のコメントにも、セッションを閉じる原因を通知しない理由 (publication / bidi と同じ) を書く。

`src/session/namespaceLoops.test.ts` の `LOOP_CASES` の `errorNotificationCount` を namespace / tracks も 0 に更新する。`LOOP_CASES` の定義とそれを使うテストの「namespace / tracks は通知する」というコメントも新しい契約に合わせる。既存の「namespaceStartNamespaceStreamLoop: error コールバックの throw を無視して破損メッセージでセッションが閉じる」は、破損メッセージ (`IncompleteDataError`) でリクエスト単位の `error` が呼ばれる前提で `REQUEST_CALLBACK_ERROR` を assert しているため、通知を抑止する契約に合わせて期待値・JSDoc・テスト名を更新する。既存の「namespaceStartNamespaceStreamLoop: 非空 Track Name の Redirect は INVALID_FIELD」には、リクエスト単位の通知 0 件と `ProtocolViolationError` での reject の assert を加える。

## 完了条件

- 購読系のリクエスト単位 `error` が、ライブラリが `closeWithError` でセッションを閉じる原因では呼ばれない
- セッションを閉じない読み取りエラー (ピアの `RESET_STREAM` など) では従来どおり通知する。ただしセッション終了起源 (`source: "session"`) は従来どおり通知しない (`isSessionClosedError` の抑止を残す)
- `ctx.reject(error)` の経路を維持する
- 契約を `src/session/publicTypes.ts` と `docs/LOW_LEVEL_API.md` に記述する
- `src/session/namespaceLoops.test.ts` で、セッションを閉じる原因 (`IncompleteDataError` / `SessionError` / `ProtocolViolationError`) ではリクエスト単位の `error` が呼ばれず、`ConnectCallbacks.error` だけが通知され、`ctx.reject` が受信したエラーで実行されることを固定する
- 既存の「namespaceStartNamespaceStreamLoop: error コールバックの throw を無視して破損メッセージでセッションが閉じる」 (テスト名を含む) と `LOOP_CASES` の定義・コメントを新しい契約に合わせて更新する
- `vp check` と `vp test --run` が通る

`CHANGES.md` は MOQT RFC ドラフト中のため更新しない (`CODEBASE.md` の特別ルール)。

## 参照

- `src/session/namespaceLoops.ts` の `namespaceHandleSubscriptionReadError` / `createPublicationStreamHandlers` の `onReadError` / `namespaceNotifyError`
- `src/session/errors.ts` の `isSessionClosedError` / `toSessionCloseError`
- `src/session/bidi.ts` の `handleRequestStreamReadError`
- `src/session/publicTypes.ts` の `NamespaceSubscriptionCallbacks` / `TracksSubscriptionCallbacks` / `NamespacePublicationCallbacks`
- `src/session/namespaceLoops.test.ts` の `LOOP_CASES` と「namespaceStartNamespaceStreamLoop: error コールバックの throw を無視して破損メッセージでセッションが閉じる」/「namespaceStartNamespaceStreamLoop: 非空 Track Name の Redirect は INVALID_FIELD」
- docs/LOW_LEVEL_API.md の「Namespace 系の扱い」
