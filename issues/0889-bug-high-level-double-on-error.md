# 高レベル API で確立後のプロトコル違反が onError に 2 回通知される

- Created: 2026-11-02
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-high-level-double-on-error
- Polished: {YYYY-MM-DD}

## 目的

高レベル API (`createMediaPublisher` の `announceNamespace`) で、告知の確立後にプロトコル違反の応答を受けた場合、1 件の原因で `onError` が 2 回呼ばれ得る。利用者が通知の回数を数えていたり、1 件の失敗で 1 回だけ処理する前提で書いている場合、同じ原因を 2 回処理してしまう。通知を 1 回に揃える。

## 現状

低レベルの `PUBLISH_NAMESPACE` の受信ループは、読み取りの catch で per-request の error コールバックと Session の error コールバックの両方へ同じ原因を届ける。

- `src/session/namespaceLoops.ts` の `runNamespaceStreamLoop` は、catch で `handlers.onReadError` を呼ぶ。`createPublicationStreamHandlers` の `onReadError` は `namespaceNotifyError` で `PublicationCallbacks.error` を呼び、その直後に `toSessionCloseError` の結果で `session.closeWithError` を呼ぶ
- `session.closeWithError` は Session の `error` コールバックを呼び、`src/createMedia/connect.ts` の `connectMediaSession` がそれを `MediaConnectSettings.onSessionError` へ配線している
- `src/createMediaPublisher.ts` の `MediaPublisherImpl` は、`announceNamespace` の `PublicationCallbacks.error` を確立後は `callbacks.onError` へ流し、`onSessionError` も `callbacks.onError` へ流している

そのため、次の経路で `onError` が 2 回呼ばれる。

- 確立後の 2 通目の `REQUEST_OK` の構造破損 (`ProtocolViolationError` / `IncompleteDataError` が catch へ抜ける)
- 確立後の `REQUEST_ERROR` の不正な Redirect (`decodeRequestErrorToRequestError` が `ProtocolViolationError` を投げる)

`src/createMediaPublisher.test.ts` の確立後の RESET テストは plain の `Error` を流すため、Session を閉じない経路 (通知 1 回) だけを固定しており、この 2 回の経路はテストで固定されていない。`docs/HIGH_LEVEL_API.md` には「確立後のプロトコル違反では `onError` が 2 回呼ばれ得る (既知の制約)」と記載している。

## 設計方針

通知の担い手を 1 層に固定する。候補は次の 2 つ。

- 低レベル側: `onReadError` で `toSessionCloseError(error) !== null` のときは per-request の error コールバックを呼ばず、Session の error コールバックに一本化する。`session` を閉じる原因は Session の通知で扱う方が、他の request 系 (subscription / fetch / track status) と揃う
- 高レベル側: 同一 tick で同じ原因の通知が重なったら 1 回に抑止する。原因の同一性判定が難しいため、低レベル側の一本化を優先する

どちらを採るかは、他の request 系 (`namespaceHandleSubscriptionReadError` など) の既存の扱いを確認してから決める。低レベル API の `error` コールバックの契約 (「読み取り失敗は per-request の error でも通知する」) を変えるなら、`docs/LOW_LEVEL_API.md` の記述と既存のテストも合わせて直す。

`onError` の回数の契約 (`docs/HIGH_LEVEL_API.md` の「確立前の失敗では 1 回」「確立後は 2 回になり得る」) を、修正後の実装に合わせて書き直す。

## 完了条件

- 確立後の 2 通目の `REQUEST_OK` の構造破損で、高レベル API の `onError` が 1 回だけ通知される (テストで固定する)。低レベル API の `PublicationCallbacks.error` と Session の `error` のどちらで通知するかを決め、その契約をテストで固定する
- 確立後の `REQUEST_ERROR` の不正な Redirect でも同じく 1 回だけ通知される
- `docs/HIGH_LEVEL_API.md` の `onError` の回数の記述を、修正後の契約に合わせる。低レベルの `error` コールバックの契約を変える場合は `docs/LOW_LEVEL_API.md` も直す
- `npx vp check` と `npx vp test --run` が通る

`CHANGES.md` は MOQT RFC ドラフト中のため更新しない (`CODEBASE.md` の特別ルール)。

## 解決方法

{未着手}

## 参照

- `src/createMediaPublisher.ts` の `MediaPublisherImpl.announceNamespace` / `notifyStartFailure` / `onSessionError` の配線
- `src/createMedia/connect.ts` の `connectMediaSession` (`onSessionError` の配線)
- `src/session/namespaceLoops.ts` の `runNamespaceStreamLoop` / `createPublicationStreamHandlers` / `namespaceNotifyError`
- `src/session/namespaces.ts` の `namespacesPublishNamespace`
- `src/error.ts` の `toSessionCloseError` / `SessionError` / `ProtocolViolationError`
- `src/createMediaPublisher.test.ts` の確立後の RESET / FIN のテスト
- `docs/HIGH_LEVEL_API.md` の「namespace の告知 (announceNamespace)」
- draft-ietf-moq-transport-22 §6.4.2.3 / §9.14
