# namespace / tracks サブスクリプションの REQUEST_UPDATE を受信すると PROTOCOL_VIOLATION でセッションを閉じる

- Created: 2026-09-16
- Completed: 2026-09-17
- Branch: feature/fix-namespace-request-update-receive
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-transport-21 §9.5.2 (Updating Namespace Subscriptions) は、確立済みの SUBSCRIBE_NAMESPACE / SUBSCRIBE_TRACKS に対して TRACK_NAMESPACE_PREFIX パラメータを含む REQUEST_UPDATE を送ることで Track Namespace Prefix を更新できると定める。§9.5 (REQUEST_UPDATE) も REQUEST_UPDATE は同じ双方向ストリーム上で送ると定める。

moqt-js は SUBSCRIBE_NAMESPACE / SUBSCRIBE_TRACKS の送信と REQUEST_UPDATE の送信 (`bidiSendNamespaceRequestUpdate`) を実装しているが、その専用ストリームで REQUEST_UPDATE を受信する経路が無い。ピアが namespace サブスクリプションを更新しようとすると未知のメッセージ種別として扱われ、PROTOCOL_VIOLATION でセッションが閉じる。§9.5.2 が定める正規の操作でセッションが落ちるため、相互運用上の障害になる。

あわせて、AUTHORIZATION TOKEN を含む REQUEST_UPDATE を受信してもトークンが処理されない。§9.20.3 (AUTHORIZATION TOKEN Parameter) は namespace 系の REQUEST_UPDATE にも AUTHORIZATION TOKEN が出現し得ると定め、§8.9 (Authorization Token Compression) は「セッションエラーにならない限り REGISTER した Alias をトークンキャッシュへ登録する MUST」を定める。

## 現状

- `src/session/bidi.ts` の `bidiSendNamespaceRequestUpdate` は `NAMESPACE_REQUEST_UPDATE_ALLOWED_PARAMS` で `AUTHORIZATION_TOKEN` と `TRACK_NAMESPACE_PREFIX` を許可し、moqt-js 自身が namespace 系 REQUEST_UPDATE を送る
- 受信側は `src/session/namespaceLoops.ts` の `runNamespaceStreamLoop` がメッセージを振り分ける。GOAWAY / REQUEST_OK / REQUEST_ERROR 以外は `handlers.onMessage` に渡る
- namespace ストリームの `onMessage` は `NAMESPACE` と `NAMESPACE_DONE` だけを処理し、それ以外は default で `unknown namespace stream message type` として PROTOCOL_VIOLATION を返してセッションを閉じる。REQUEST_UPDATE はここに落ちる
- tracks ストリームの `onMessage` は `PUBLISH_SKIPPED` だけを処理し、同じく default で `unknown tracks stream message type` として PROTOCOL_VIOLATION を返す
- どちらの経路も AUTHORIZATION TOKEN の処理を呼んでいない。`PROCESS_INCOMING` 相当の処理は subscription 系 REQUEST_UPDATE (`bidiPreflightRequestUpdate` 経由) にしか無い
- `src/session/namespaceLoops.ts` の `namespaceHandleRequestOkMessage` は REQUEST_OK の後に届く REQUEST_UPDATE_OK を処理する分岐を持つが、その前提となる REQUEST_UPDATE 自体を受信できない
- 他実装の moqt-rs は namespace 系を含む受信経路で認証トークンを処理する

## 設計方針

namespace ストリームと tracks ストリームの `onMessage` に REQUEST_UPDATE の分岐を追加し、subscription 系 REQUEST_UPDATE と同じ順序で処理する。

- AUTHORIZATION TOKEN を最初に処理する。§8.9 の登録 MUST を満たすため、セッションエラーにならない拒否より前に処理する。未登録 Alias の参照は `UNKNOWN_AUTH_TOKEN_ALIAS` (0x17) の Session Termination で扱う。0x17 は §16.11.1 にのみ登録され §16.11.2 に無い (issue 0612 と同じ解釈)
- パラメータスコープを `NAMESPACE_REQUEST_UPDATE_ALLOWED_PARAMS` で検証する。許可されない型は §9.20.1 の MUST により PROTOCOL_VIOLATION でセッションを閉じる
- TRACK_NAMESPACE_PREFIX の更新を受理する。§9.5.2 の制限 (新しい prefix が同一セッション内の他の active な SUBSCRIBE_NAMESPACE / SUBSCRIBE_TRACKS と共通 prefix を持たない MUST) は、サブスクリプション種別ごとに独立に検証する
- §9.5 の応答 MUST に従い REQUEST_UPDATE_OK または REQUEST_ERROR を 1 通返す。応答の送信は subscription 系と同じヘルパーを使う。`bidiSendRequestOk` と `bidiSendRequestError` は `src/session/bidi.ts` の内部関数であり `src/session/namespaceLoops.ts` から呼べないため、公開の入口を追加するか namespace 系の応答送信を bidi.ts に置くかを実装時に決める
- REQUEST_UPDATE_OK に載せられるパラメータは `REQUEST_UPDATE_OK_ALLOWED_PARAMS` で検証する。namespace 系の更新応答も同じ集合を使う
- §9.5.1 の PUBLISH_DONE (UPDATE_FAILED) は subscription の publisher が負う MUST であり、namespace 系には適用しない
- GOAWAY 受信済みのストリームでは、subscription 系と同じく更新を拒否する扱いに揃える

## 完了条件

- 確立済みの SUBSCRIBE_NAMESPACE / SUBSCRIBE_TRACKS のストリームで REQUEST_UPDATE を受信しても、PROTOCOL_VIOLATION でセッションが閉じない
- TRACK_NAMESPACE_PREFIX を含む REQUEST_UPDATE に対して REQUEST_UPDATE_OK または REQUEST_ERROR が 1 通返る
- AUTHORIZATION TOKEN の REGISTER を含む REQUEST_UPDATE を受信すると、Alias がトークンキャッシュへ登録される
- 未登録 Alias の USE_ALIAS を含む REQUEST_UPDATE を受信すると、`SessionErrorCode.UNKNOWN_AUTH_TOKEN_ALIAS` の Session Termination でセッションが閉じる
- §9.20.1 に違反するパラメータを含む REQUEST_UPDATE は PROTOCOL_VIOLATION でセッションが閉じる
- 上記を検証するテストがある
- `vp check` / `tsc --noEmit` / `vp test run` が通る

## 参照

- draft-ietf-moq-transport-21 §8.9 (Authorization Token Compression)
- draft-ietf-moq-transport-21 §9.5 (REQUEST_UPDATE)
- draft-ietf-moq-transport-21 §9.5.1 (Updating Subscriptions)
- draft-ietf-moq-transport-21 §9.5.2 (Updating Namespace Subscriptions)
- draft-ietf-moq-transport-21 §9.20.3 (AUTHORIZATION TOKEN Parameter)
- draft-ietf-moq-transport-21 §9.20.21 (TRACK_NAMESPACE_PREFIX Parameter)
- draft-ietf-moq-transport-21 §16.11.1 (Session Termination Error Codes)
- draft-ietf-moq-transport-21 §16.11.2 (REQUEST_ERROR Codes)

## 解決方法

調査の結果、報告されている「ピアが namespace サブスクリプションを更新しようとすると PROTOCOL_VIOLATION でセッションが閉じる」は
draft-ietf-moq-transport-21 の MUST に沿った動作であり、挙動の修正は不要と判断した。コードの変更は行わず、判断の根拠をコメントとテストで固定した。

- §9.5 (REQUEST_UPDATE): REQUEST_UPDATE を送れるのは「要求の送信者」と「PUBLISH で確立した購読の subscriber」の 2 ケースのみで、
  「An endpoint that receives a REQUEST_UPDATE other than in the two cases above MUST close the session with a PROTOCOL_VIOLATION.」。
  SUBSCRIBE_NAMESPACE / SUBSCRIBE_TRACKS の送信者は自側 (subscriber) であるため、ピアからの受信はこの MUST の対象になる
- §9.5.2 (Updating Namespace Subscriptions): 「A subscriber can update the Track Namespace Prefix of an established
  SUBSCRIBE_NAMESPACE or SUBSCRIBE_TRACKS by including the TRACK_NAMESPACE_PREFIX parameter ... in a REQUEST_UPDATE.」—
  更新を送るのは subscriber (要求の送信者) である。自側の送信は `bidiSendNamespaceRequestUpdate`、その応答処理は
  `namespaceHandleRequestOkMessage` が既に担っている
- moqt-js は SUBSCRIBE_NAMESPACE / SUBSCRIBE_TRACKS を responder として受理しない
  (`incomingClassifyFirstBidiMessage` が未対応リクエストとして REQUEST_ERROR を返す)。したがって自側が namespace ストリームの
  responder になる経路が無く、REQUEST_UPDATE を受理してトークン処理や応答を行う必要はない
- relay も、上流 publisher からの REQUEST_UPDATE の下流転送は PUBLISH 起点の購読 (PUBLISH 起点の購読) のみを対象としており、
  namespace 系ストリームへは送らない
- 誤って「受理する」実装に変えないよう、`src/session/namespaceLoops.ts` の namespace / tracks 両ループの default 分岐に、
  §9.5 の 2 ケースに該当しないことと §9.5.2 の送信者が subscriber であることをコメントで明記した
- `src/session/namespaceLoops.test.ts` に、確立済みの namespace / tracks ストリームで TRACK_NAMESPACE_PREFIX 付き
  REQUEST_UPDATE を受信すると PROTOCOL_VIOLATION で閉じ、prefix が更新されないことを検証するテストを追加した

検証は `pnpm exec tsc --noEmit` / `pnpm exec vp check` / `pnpm test --run` (2245 passed) の通過で確認した。
