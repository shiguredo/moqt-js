# ピア起点のセッション終了で publication のリクエスト単位通知が順序依存になる

- Created: 2026-11-03
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-publish-namespace-session-closed-notification
- Polished: {YYYY-MM-DD}

## 目的

ピア起点でセッションが終了したとき、WebTransport のセッション終了起源の読み取り失敗 (`source: "session"`) は `toSessionCloseError` が null を返すため、publication の `onReadError` でリクエスト単位の `error` コールバックが呼ばれる。呼ばれるかどうかは、`transport.closed` ハンドラが対象の state を `"closed"` にする処理と、ストリームの読み取り失敗のどちらが先に処理されるかで変わる。namespace / tracks / bidi はセッション終了起源を抑止しており、publication だけ非対称である。高レベル API では、正常なピア close で `onError` と `onClose` が続けて呼ばれ得る。

## 現状

- `src/session/errors.ts` の `isSessionClosedError` は `source: "session"` を判定する
- `src/session/namespaceLoops.ts` の `namespaceHandleSubscriptionReadError` は `!isSessionClosedError(error)` のときだけ通知するため、購読系はセッション終了起源で通知しない
- publication の `onReadError` は `toSessionCloseError(error) === null` のとき通知するため、セッション終了起源のエラーを通知する
- `src/session/bidi.ts` の `handleRequestStreamReadError` は `!isPeerStreamError(error)` で早期 return するため、セッション終了起源を通知しない
- `src/session/lifecycle.ts` の `markRequestObjectsClosed` は全リクエストの state を `"closed"` にする
- `src/session.ts` の `transport.closed` ハンドラは `markRequestObjectsClosed` を呼ぶ。`src/session/incomingPublish.ts` は「transport.closed がストリームのエラーより先に処理される順序への防御」と明記しており、逆順があり得ることをコードベース自身が認めている
- `src/createMediaPublisher.ts` の `announceNamespace` は確立後ならリクエスト単位の `error` を `callbacks.onError` に流す
- `docs/HIGH_LEVEL_API.md` と `src/session/publicTypes.ts` は、セッション終了処理との順序により通知され得ることを明記している (順序依存を契約として書いている)

## 設計方針

publication の `onReadError` に `isSessionClosedError(error)` の抑止を追加し、namespace / tracks と同一規則にする。セッション終了起源は state を閉じるだけにし、通知はセッション単位のコールバック (`ConnectCallbacks.close` / `ConnectCallbacks.error`) に委ねる。これにより挙動が順序に依存しなくなる。

契約の記述から「セッション終了処理との順序により呼ばれることがある」を削除し、「セッション終了起源 (`source: "session"`) では呼ばない」に統一する。

## 完了条件

- `source: "session"` の読み取り失敗で publication のリクエスト単位 `error` が呼ばれない
- namespace / tracks の購読と同一の規則になる
- `src/session/publicTypes.ts` の JSDoc と `docs/HIGH_LEVEL_API.md` / `docs/LOW_LEVEL_API.md` を更新する
- `src/session/namespaceLoops.test.ts` に `source: "session"` を注入し、通知 0 件と state の `"closed"` を固定するテストを追加する
- `vp check` と `vp test --run` が通る

`CHANGES.md` は MOQT RFC ドラフト中のため更新しない (`CODEBASE.md` の特別ルール)。

## 参照

- `src/session/errors.ts` の `isSessionClosedError`
- `src/session/namespaceLoops.ts` の `createPublicationStreamHandlers` の `onReadError` / `namespaceHandleSubscriptionReadError`
- `src/session/bidi.ts` の `handleRequestStreamReadError`
- `src/session/lifecycle.ts` の `markRequestObjectsClosed`
- `src/session.ts` の `transport.closed` ハンドラ
- `src/createMediaPublisher.ts` の `announceNamespace`
- `docs/HIGH_LEVEL_API.md` の「namespace の告知 (announceNamespace)」
- draft-ietf-moq-transport-22 §6.6 / §9.2
