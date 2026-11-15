# PUBLISH_NAMESPACE の debug の send イベントがストリーム作成前に出る

- Created: 2026-11-03
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-debug-send-before-stream
- Polished: 2026-11-15
- Refreshed: 2026-11-14

## 目的

`Session.publishNamespace()` は `PUBLISH_NAMESPACE` の debug イベントを、双方向ストリームの作成と reader / writer の取得より前に出している。ストリームの作成や取得が失敗した場合も `direction: "send"` のイベントが出るため、実際には transport に渡っていないメッセージが「送信した」ように見える。既存の `publish()` / `subscribe()` / `subscribeNamespace()` / `subscribeTracks()` はストリームを作成してから debug を出しており、非対称である。

## 現状

- `src/session/namespaces.ts` の `namespacesPublishNamespace` は、パラメータ構築・encode・debug コールバックをすべて送信 (detached な `namespacesSendPublishNamespace`) より前に行う
- `namespacesPublishNamespace` の debug イベントは `createBidirectionalStream` の前になり、`namespacesSendPublishNamespace` の認可トークンの予約よりも前になる
- `namespacesPublishNamespace` は `session.callbacks.debug` を直接呼び、`namespacesSendSubscription` / `requestsSendRequest` が使う `session.emitDebug` を使っていない
- `namespacesPublishNamespace` の Promise executor は、debug コールバックが同期的に Session を閉じることを前提に状態を再確認している
- `namespacesSubscribeNamespace` / `namespacesSubscribeTracks` (送信の async 部は `namespacesSendSubscription`) と `src/session/requests.ts` の publish / subscribe は、ストリーム作成後に debug を出してから write する
- `docs/LOW_LEVEL_API.md` の `ConnectCallbacks.debug` は「送受信した MOQT メッセージの raw 情報」と説明している
- 0890 で送信を detached にした際、debug を送信前 (Promise 作成前) に置いた。debug の throw を送信前失敗として扱うための判断だったが、コメントには debug コールバックを送信前に済ませる対象として挙げているだけで、その理由は書かれていない
- `src/session.ts` の `SessionImpl.publishNamespace` の JSDoc は、debug コールバックの throw を `namespacesPublishNamespace` の同期 throw の一つとして列挙している
- `src/session.test.ts` の `publishNamespace: 送信前の throw ではストリームを作らない` は debug コールバックの throw で送信前失敗を起こしており、`publishNamespace: debug コールバックの同期 close でも reject する` はストリームを作らないことを前提にしている

## 設計方針

debug の send イベントを、送信処理のストリーム作成・reader / writer 取得・認可トークンの予約の後、Session の状態確認と `writer.write` の前へ移す。`namespacesSendSubscription` の手順 4-2 / 4-3 と同じ位置に揃える。

- イベントの payload と decoded は `NamespacePublishSendRequest` に載せて送信処理へ渡し、送信処理では `session.emitDebug("send", MessageType.PUBLISH_NAMESPACE, payload, decoded)` で出す
- 認可トークンの予約より後に出すため、予約の失敗では debug の send イベントを出さない
- debug が throw した場合は送信の catch で予約を取り消し、`pendingNamespacePublication` の登録を削除して元のエラーで reject し、取得済みの reader / writer を `"namespace request send failed"` で解放する
- debug コールバックが同期的に Session を閉じた場合は write せず、予約を取り消し、`pendingNamespacePublication` の登録を削除して `"session closed"` で reject し、reader / writer を `"session closed"` で解放する (`namespacesSendSubscription` の手順 4-3 と同じ)
- ストリーム作成・reader / writer 取得の失敗では debug の send イベントを出さない (debug を取得の後に置くため)
- write の前に出すため、write が失敗した場合も debug の send イベントは出る (既存の送信経路と同じ)
- 送信待ちの登録の削除と reject は、ストリームの解放 (await を伴う) より先に行う (Session 終了時に汎用の終了の理由で先に reject しないようにするため)
- `src/session.test.ts` の `publishNamespace: 送信前の throw ではストリームを作らない` は、debug 以外の同期 throw (検証エラーや、ピアの `MAX_CONTROL_MESSAGE_SIZE` を小さくしたフレーミングの失敗など) で固定する形に更新する
- `src/session.test.ts` の `publishNamespace: debug コールバックの同期 close でも reject する` は、ストリームを作成し、write せずに `"session closed"` で解放する形に更新する
- debug の throw でストリームを解放し元のエラーで reject すること、ストリーム作成・reader / writer 取得・予約の失敗では debug の send イベントが出ないことをテストで固定する
- 代替として debug を「送信試行」と定義して docs に明記する案もあるが、既存の送信経路 (`requestsSendRequest` / `namespacesSendSubscription`) との一貫性を優先して位置を揃える
- テストを先に更新してから実装し、実装後に `vp check` と `vp test --run` で確認する

## 完了条件

- ストリーム作成・reader / writer 取得・認可トークンの予約の失敗では debug の send イベントが出ない
- debug の throw では予約を取り消し、`pendingNamespacePublication` の登録を削除し、取得済みの reader / writer を `"namespace request send failed"` で解放し、元のエラーで reject する
- debug コールバックが同期的に Session を閉じた場合は write せず、予約を取り消し、`pendingNamespacePublication` の登録を削除し、`"session closed"` で reject し、reader / writer を `"session closed"` で解放する
- 送信成功時の debug イベントの内容 (payload / decoded / type / typeName) は変わらないことをテストで固定する
- write が失敗した場合も debug の send イベントは出る (write の前のため)。これをテストで固定する (既存の write 失敗テストに debug の記録を加える)
- 既存の `publishNamespace: 送信前の throw ではストリームを作らない` と `publishNamespace: debug コールバックの同期 close でも reject する` を新しい契約に更新する
- `publishNamespace: debug コールバックの throw で元のエラーで reject し "namespace request send failed" でストリームを解放する` を追加する (予約の取り消しも固定する)
- ストリーム作成・reader / writer 取得・予約の失敗で debug の send イベントが出ないことをテストで固定する (既存の getReader / getWriter 失敗のテストに debug の記録が空であることを加え、ストリーム作成失敗と予約失敗は新しいテストを追加する)
- 既存の write 失敗時の予約の取り消しとストリームの解放が引き続き通る
- `docs/LOW_LEVEL_API.md` の `ConnectCallbacks.debug` の表と、Namespace 系の扱い / デバッグと統計に、debug の send イベントの位置 (ストリーム作成・reader / writer 取得・予約の後、write の前)、作成・取得・予約の失敗では出さないこと、write 失敗時も出ることを書く
- `src/session.ts` の `SessionImpl.publishNamespace` の JSDoc から debug コールバックの throw を同期 throw の列挙から外し、detached な送信が reject することを書く
- `src/session/namespaces.ts` の `namespacesPublishNamespace` の同期部のコメント、`namespacesSendPublishNamespace` の手順コメント、Promise executor の再確認のコメントを新しい位置に合わせる
- `vp check` と `vp test --run` が通る

`CHANGES.md` は MOQT RFC ドラフト中のため更新しない (`CODEBASE.md` の特別ルール)。

## 参照

- `src/session/namespaces.ts` の `namespacesPublishNamespace` / `namespacesSendPublishNamespace` / `namespacesSubscribeNamespace` / `namespacesSubscribeTracks` / `namespacesSendSubscription`
- `src/session/requests.ts` の publish / subscribe の debug 呼び出し
- `src/session/bidi.ts` の debug 呼び出し
- `src/session/lifecycle.ts` の `sessionEmitDebug` / `sessionRejectPendingRequests`
- `src/session.ts` の `SessionImpl.publishNamespace` の JSDoc と async コメント
- `src/session/publicTypes.ts` の `ConnectCallbacks.debug`
- `src/session.test.ts` の publishNamespace の送信前 throw / debug / 送信失敗のテスト
- `docs/LOW_LEVEL_API.md` の `ConnectCallbacks` / 通常の request stream / Namespace 系の扱い / デバッグと統計
