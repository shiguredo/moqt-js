# 高レベル API で確立後のプロトコル違反が onError に 2 回通知される

- Created: 2026-11-02
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-high-level-double-on-error
- Polished: 2026-11-03

## 目的

高レベル API (`createMediaPublisher` の `announceNamespace`) で、告知の確立後にプロトコル違反の応答を受けた場合、1 件の原因で `onError` が 2 回呼ばれ得る。利用者が通知の回数を数えていたり、1 件の失敗で 1 回だけ処理する前提で書いている場合、同じ原因を 2 回処理してしまう。通知を 1 回に揃える。

## 現状

低レベルの `PUBLISH_NAMESPACE` の受信ループは、読み取りの catch で per-request の error コールバックと Session の error コールバックの両方へ同じ原因を届ける。

- `src/session/namespaceLoops.ts` の `runNamespaceStreamLoop` は、catch で `handlers.onReadError(ctx, error)` を呼んだ後に `toSessionCloseError(error)` の結果で `session.closeWithError(sessionError)` を呼ぶ
- `createPublicationStreamHandlers` の `onReadError` は `namespaceNotifyError` で `NamespacePublicationCallbacks.error` を呼ぶ
- `session.closeWithError` は `src/session/lifecycle.ts` の `sessionCloseWithError` で Session の `callbacks.error` を呼び、`src/createMedia/connect.ts` の `connectMediaSession` がそれを `MediaConnectSettings.onSessionError` へ配線している
- `src/createMediaPublisher.ts` の `MediaPublisherImpl` は、`announceNamespace` の `NamespacePublicationCallbacks.error` を確立後は `callbacks.onError` へ流し (`established` が true の分岐)、`onSessionError` も `callbacks.onError` へ流している

そのため、次の経路で `onError` が 2 回呼ばれる。

- 確立後の 2 通目の `REQUEST_OK` の構造破損 (`src/session/namespaceLoops.ts` の `namespaceDecodeRequestOkWithoutTrackProperties` が `MalformedTrackError` 以外を再 throw し、`runNamespaceStreamLoop` の catch へ抜ける)
- 確立後の `REQUEST_ERROR` の不正な Redirect (`decodeRequestErrorToRequestError` が `ProtocolViolationError` を投げ、同じ catch へ抜ける)
- 確立後の未知メッセージ (`onMessage` は `closeWithError` だけを呼ぶため 2 回にはならない。この経路は対象外)

`src/createMediaPublisher.test.ts` の「namespacePublication: 確立後の RESET は通知し FIN は state で観測する」は plain の `Error` を `notifyNamespacePublicationError` で流すため、Session を閉じない経路 (通知 1 回) だけを固定しており、この 2 回の経路はテストで固定されていない。`docs/HIGH_LEVEL_API.md` の「namespace の告知 (announceNamespace)」には「確立後にプロトコル違反の応答を受けた場合は、低レベルの per-request コールバックと Session エラーの両方が通知されるため `onError` が 2 回呼ばれ得る (既知の制約)」と記載している。

### 他の request 系との違い (設計判断の根拠)

`src/session/bidi.ts` の `handleRequestStreamReadError` (受信 PUBLISH / SUBSCRIBE / FETCH の受信ループ。役割は `BidiRequestStreamRole` の `"publish"` / `"subscribe"` / `"fetch"`。TRACK_STATUS は単発リクエストで確立後のループを持たない) は、`toSessionCloseError(error) !== null` のとき `session.closeWithError(sessionError)` を呼んで `return` する。per-request の error コールバックは呼ばない。

一方、namespace / tracks の購読 (`namespaceHandleSubscriptionReadError`) は条件が異なり、`isSessionClosedError(error)` のときだけ通知を抑止する。`isSessionClosedError` (`src/session/errors.ts`) は WebTransport の `source === "session"` を判定する関数であり、`toSessionCloseError(error) !== null` (SessionError / ProtocolViolationError / IncompleteDataError) とは判定対象が違う。購読系は `ProtocolViolationError` でも `namespaceNotifyError` を呼ぶ。

つまり「Session を閉じる原因は Session の error コールバックだけで通知する」は **bidi 系には当てはまるが、namespace / tracks の購読には当てはまらない**。`PUBLISH_NAMESPACE` の `onReadError` は、bidi 系と同じ `toSessionCloseError` の判定を持たずに per-request の通知を先に行っている点が問題である。本 issue では bidi 系の形 (`toSessionCloseError(error) !== null` で分岐) に揃える。namespace / tracks の購読の条件は変えない。

なお、`onRequestOk` / `onRequestError` の検証失敗 (`namespaceRejectAndCloseWithError` と `namespaceDecodeRequestOkWithoutTrackProperties`) は per-request の通知をせず reject と `closeWithError` だけを行うが、**decode が throw する経路 (`MalformedTrackError` 以外の再 throw、不正 Redirect の `ProtocolViolationError`) は `onReadError` に落ちる**ため本 issue の対象になる。`namespaceRejectAndCloseWithError` を通る経路 (スコープ違反・Track Properties 違反・未知メッセージ) だけが対象外である。

## 設計方針

`PUBLISH_NAMESPACE` の `onReadError` を bidi 系に揃える。

- `toSessionCloseError(error) !== null` のとき (= Session を閉じる原因) は per-request の `namespaceNotifyError` を呼ばず、Session の error コールバックに一本化する。catch 側の `closeWithError` がそのまま通知を担うため、高レベル API の `onError` は 1 回になる
- **`ctx.reject(error)` は維持する**。bidi 系の「早期 return」をそのまま写すと、未確立の `publishNamespace()` に渡す reject が飛び、`sessionRejectPendingRequests` の `new Error("session closed")` で settle して失敗理由が別物になる (未確立の `publishNamespace()` の待ちで `ProtocolViolationError` が失われる)。通知の有無だけを分岐し、reject の経路は残す
- セッションを閉じない読み取りエラー (ピアの `RESET_STREAM` など) は、従来どおり per-request の `error` コールバックで通知する。この経路は Session が閉じないため二重にならず、既存のテスト (plain `Error` の RESET で 1 回) の契約を変えない

この変更で低レベル API の `NamespacePublicationCallbacks.error` の契約が変わる (「セッションを閉じる原因では呼ばれない」)。`docs/LOW_LEVEL_API.md` に `error` コールバックの契約を書いた記述は無いため、必要なら契約を追記する。`docs/HIGH_LEVEL_API.md` の「2 回呼ばれ得る (既知の制約)」は削除し、「確立後のプロトコル違反でも 1 回」に直す。

`onError` の回数の契約 (`docs/HIGH_LEVEL_API.md` の「確立前の失敗では 1 回」「確立後は 2 回になり得る」) を、修正後の実装に合わせて書き直す。

## 完了条件

- `src/session/namespaceLoops.ts` の `createPublicationStreamHandlers` の `onReadError` が、`toSessionCloseError(error) !== null` のとき per-request の error コールバックを呼ばない。namespace / tracks の購読の条件 (`isSessionClosedError`) は変えない
- **`ctx.reject(error)` の経路を維持する**。通知を抑止しても、未確立の `publishNamespace()` の待ちは同じ error (`ProtocolViolationError` など) で reject されることを `src/session/namespaceLoops.test.ts` で固定する。このテストは reject を no-op にせず、渡された値を assert する (既存の「非空 Track Name の Redirect は PROTOCOL_VIOLATION」テストは reject を no-op にしているため、reject が飛んでも検出できない)
- 低レベル API の `NamespacePublicationCallbacks.error` が Session を閉じる原因では呼ばれないことを、`src/session/namespaceLoops.test.ts` で固定する
- 高レベル API の `onError` が、確立後に Session エラーが届いたときに 1 回だけ通知されることを `src/createMediaPublisher.test.ts` で固定する。ハーネスは `runNamespaceStreamLoop` を回さないため、これは高レベル側の配線 (Session エラー → `onError`) の確認であり、修正前でも通る。回帰を検出するのは上記の低レベル 2 件である
- **既存テストの更新**: `src/session/namespaceLoops.test.ts` の「error コールバックの throw を無視して reject とセッションクローズが実行される」は `LOOP_CASES` (namespace / tracks / publication) で回り、次の 2 つを assert している。publication の期待値を更新する。
  - `assert.equal(notifiedMessages.length, 1)` → publication は 0 回、namespace / tracks は 1 回
  - `assertRequestCallbackErrorRecord(...)` → publication は通知しないため `REQUEST_CALLBACK_ERROR` の記録が 0 件になる。このヘルパは `records.length === 1` を要求するため、publication では記録が無いことを確かめる形に直す
  - reject と close が実行されること、close に渡す値と reject の値が同一であることの検証は維持する
- セッションを閉じない読み取りエラー (plain `Error`) では、従来どおり `NamespacePublicationCallbacks.error` と高レベル API の `onError` が 1 回通知される (既存テストの契約を変えない)
- `docs/HIGH_LEVEL_API.md` の `onError` の回数の記述から「2 回呼ばれ得る (既知の制約)」を消し、修正後の契約に合わせる。低レベルの `error` コールバックの契約を書く場合は `docs/LOW_LEVEL_API.md` にも追記する
- `npx vp check` と `npx vp test --run` が通る

`CHANGES.md` は MOQT RFC ドラフト中のため更新しない (`CODEBASE.md` の特別ルール)。

## 解決方法

{未着手}

## 参照

- `src/createMediaPublisher.ts` の `MediaPublisherImpl.announceNamespace` / `notifyStartFailure` / `onSessionError` の配線
- `src/createMedia/connect.ts` の `connectMediaSession` (`onSessionError` の配線)
- `src/session/namespaceLoops.ts` の `runNamespaceStreamLoop` / `createPublicationStreamHandlers` / `namespaceNotifyError` / `namespaceHandleSubscriptionReadError` / `decodeRequestErrorToRequestError` / `namespaceDecodeRequestOkWithoutTrackProperties`
- `src/session/bidi.ts` の `handleRequestStreamReadError` (他の request 系の先例) と `defaultBidiHandleCloseError`
- `src/session/lifecycle.ts` の `sessionCloseWithError`
- `src/session/publicTypes.ts` の `NamespacePublicationCallbacks`
- `src/session/errors.ts` の `toSessionCloseError` / `isSessionClosedError` / `toTrackPropertiesViolationSessionError`
- `src/error.ts` の `SessionError` / `ProtocolViolationError` / `MalformedTrackError`
- `src/session/namespaceLoops.test.ts` の `LOOP_CASES` と「error コールバックの throw を無視して reject とセッションクローズが実行される」
- `src/createMediaPublisher.test.ts` の確立後の RESET / FIN のテストと、テスト用ハーネスの `notifyNamespacePublicationError`
- `docs/HIGH_LEVEL_API.md` の「namespace の告知 (announceNamespace)」
- draft-ietf-moq-transport-22 §6.4.2.3 / §8.3 / §9.3 / §9.14
