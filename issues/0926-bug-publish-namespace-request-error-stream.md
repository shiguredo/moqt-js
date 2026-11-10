# PUBLISH_NAMESPACE の確立後の REQUEST_ERROR でセッションを閉じずストリームも残る

- Created: 2026-11-03
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-publish-namespace-request-error-stream
- Polished: 2026-11-10

## 目的

`Session.publishNamespace()` で公開を確立した後に `REQUEST_ERROR` を受けると、publication の state を `"closed"` にして `namespacePublications` から削除するが、送信方向の writer を FIN / abort せず、受信方向の reader も cancel しない。ストリームがセッション終了まで開いたまま残る。また draft-ietf-moq-transport-23 §4.1 は、PUBLISH_NAMESPACE への応答 (PUBLISH_NAMESPACE_OK または PUBLISH_NAMESPACE_ERROR) は 1 通だけであり、2 通以上を受けた publisher は UNEXPECTED_MESSAGE でセッションを閉じる SHOULD と定める (「The publisher SHOULD close the session with UNEXPECTED_MESSAGE if it receives more than one.」)。2 通目の `REQUEST_OK` は UNEXPECTED_MESSAGE で閉じるが、確立後の `REQUEST_ERROR` は閉じず、扱いが非対称である。確立後の `REQUEST_ERROR` を §4.1 の 2 通目の応答として UNEXPECTED_MESSAGE でセッションを閉じ、ストリームの放置も同時に解消する。

先に open の 0933 (PR #543。マージ後は `issues/closed/` に移る) を対応する必要がある。0933 は同じ `src/session/namespaceLoops.ts` / `src/session/namespaceLoops.test.ts` と、`docs/LOW_LEVEL_API.md` の「Namespace 系の扱い」を変更するため、その後に着手して編集の衝突を避ける。

## 現状

- `src/session/namespaceLoops.ts` の `createPublicationStreamHandlers` の `onRequestError` は、GOAWAY の受信後なら `"continue"` で無視する。それ以外は `decodeRequestErrorToRequestError` を通し (namespace-scoped Redirect の検証を含む)、state を `"closed"` にして `namespaceNotifyError` を呼ぶ。確立前は `ctx.reject(error)` のあと `namespaceCloseRequestStreamQuiet` で送信方向の FIN と受信方向の cancel を行うが、確立後は何もせず `"return"` する
- `runNamespaceStreamLoop` の `finally` は、`closeTarget` (state を `"closed"` にする)、`streamReader.releaseLock()`、cleanup (`namespacePublications` からの削除) を行い、writer の close / abort と reader の cancel は行わない
- ループの `finally` で `namespacePublications` から削除されるため、`src/session/lifecycle.ts` の `sessionClose` が `namespacePublications` を走査しても回収できない
- `NamespacePublication.done()` (`src/session/namespaces.ts` の `namespacesCloseNamespacePublication`) は `namespacePublications` から publication を引き、state が `"closed"` なら早期 return するため、ストリームを閉じられない
- `onRequestOk` は、確立後の 2 通目の `REQUEST_OK` を `received duplicate REQUEST_OK on PUBLISH_NAMESPACE stream` の UNEXPECTED_MESSAGE で閉じる。重複の判定は decode の後である。テスト「namespaceStartPublicationStreamLoop: 確立後の 2 通目 REQUEST_OK は重複として閉じ、reject しない」が固定している
- 購読系 (subscribeNamespace / subscribeTracks) の `handleNamespaceRequestUpdateError` は、保留中の更新が無い確立後の `REQUEST_ERROR` を `` `received REQUEST_ERROR after REQUEST_OK on ${streamKind} stream` `` の UNEXPECTED_MESSAGE で閉じる (テスト「保留中の更新が無い REQUEST_ERROR は UNEXPECTED_MESSAGE で閉じる」。`SUBSCRIPTION_LOOP_CASES` のみで publication は含まない)。購読系はこの判定を decode より前に行う
- publication は REQUEST_UPDATE を送らない。`src/session/publicTypes.ts` の `NamespacePublication` は `state` / `namespace` / `done()` だけを持ち、`onRequestOk` のコメントも「publication ストリームは REQUEST_UPDATE を扱わないため確立前のみ」と書く。draft-23 §9.5 は PUBLISH_NAMESPACE への REQUEST_UPDATE を許すが、このライブラリは送らないため、確立後の `REQUEST_ERROR` は REQUEST_UPDATE の失敗 (§9.5.1) ではあり得ず、必ず §4.1 の 2 通目の応答になる (§1.5 の呼称では PUBLISH_NAMESPACE への REQUEST_ERROR が PUBLISH_NAMESPACE_ERROR)
- draft-23 §4.1 は、受理の撤回は request の cancel (§6.4.2.3) で行うと定める (「A subscriber can cancel the request (see Section 6.4.2.3) to revoke acceptance of a PUBLISH_NAMESPACE.」)。`REQUEST_ERROR` は撤回の手段ではない
- `src/session/publicTypes.ts` の `NamespacePublicationCallbacks.error` の JSDoc の 1 項目目は「デコードと namespace-scoped Redirect の検証を通った `REQUEST_ERROR` を受けたとき」で、確立の前後を区別していない。`docs/LOW_LEVEL_API.md` の「Namespace 系の扱い」の `publishNamespace()` の項目も「それ以外の `REQUEST_ERROR` と読み取り失敗では呼ぶ」と書く
- `docs/HIGH_LEVEL_API.md` の「namespace の告知 (announceNamespace)」は「確立後にプロトコル違反の応答を受けた場合も、Session を閉じる原因では Session のエラーだけが通知されるため `onError` は 1 回だけ通知される」と書いている

## 設計方針

- 確立後の `REQUEST_ERROR` は §4.1 の 2 通目の応答として、UNEXPECTED_MESSAGE でセッションを閉じる (§12.2 の UNEXPECTED_MESSAGE の定義は「more times than allowed」を含む)。閉じない案 (ストリームの両方向を閉じるだけ) は採らない。§4.1 の SHOULD から外れる根拠が無く、2 通目の `REQUEST_OK` と購読系の扱いとの非対称が残るためである
- `onRequestError` の処理の順は次のとおりとする
  1. GOAWAY の受信後なら、従来どおり `"continue"` で無視する (変えない。GOAWAY 後の `REQUEST_ERROR` を無視する扱いは closed の 0372 で決めた。§9.2 は、要求ストリームで GOAWAY を受けた request の送信側が、その request を出し直して古い要求ストリームを閉じる SHOULD を定める)
  2. `decodeRequestErrorToRequestError` を通す (変えない)。不正な `REQUEST_ERROR` (デコードの失敗と、§9.4.2.1 の Redirect の検証違反) は、従来どおり `runNamespaceStreamLoop` の catch を経て、そのエラーのコードでセッションを閉じる (例: Redirect の Track Name が非空なら INVALID_FIELD)。同じハンドラの `onRequestOk` が decode の後に重複を判定するのと揃え、デコードと検証の MUST を §4.1 の SHOULD より優先する。購読系 (`handleNamespaceRequestUpdateError`) は、保留中の更新が無い場合は decode より前に UNEXPECTED_MESSAGE で閉じる。そのため、確立後で保留中の更新が無いときの不正な Redirect では、閉じるコードが購読系は UNEXPECTED_MESSAGE、publication は INVALID_FIELD と分かれる (保留中の更新がある購読系は decode を通るため INVALID_FIELD で揃う)。これは意図した差であり、購読系の順序は変えない
  3. 確立後 (`ctx.progress.resolved`) なら、`ctx.session.closeWithError(new SessionError("received REQUEST_ERROR after REQUEST_OK on PUBLISH_NAMESPACE stream", SessionErrorCode.UNEXPECTED_MESSAGE))` を呼んで `"return"` する。state の変更、`namespaceNotifyError`、`ctx.reject` は行わない (`NamespacePublicationCallbacks.error` の「セッションを閉じる原因では呼ばない」契約に従い、確立済みのため reject もしない)
  4. 確立前は現状のまま
- ストリームは `closeWithError` から同期的に呼ばれる `sessionClose` が、ループの `finally` の cleanup より前に `namespacePublications` を走査して writer を abort し reader を cancel するため、`namespaceCloseRequestStreamQuiet` を別に呼ぶ必要は無い
- 前提: publication は REQUEST_UPDATE を送らない。`NamespacePublication` に `update()` を加える場合は、確立後の `REQUEST_ERROR` が REQUEST_UPDATE の失敗であり得るため、この判断を見直す
- 高レベル API では、確立後の `REQUEST_ERROR` で「リクエスト単位の `onError` を通知して配信を続ける」挙動が「Session を閉じる (Session のエラーとして `onError` を 1 回通知する)」挙動に変わる。`docs/HIGH_LEVEL_API.md` の既存の記述と整合する
- 0927 との関係: 0927 も `NamespacePublicationCallbacks.error` の JSDoc と `docs/LOW_LEVEL_API.md` の `publishNamespace()` の項目を変える (0926 は `REQUEST_ERROR` の項目、0927 は読み取り失敗の項目で、内容は重ならない)。後から着手する側が先の文言を前提に書き換え、両方の変更を残す

## 完了条件

- 公開の確立後 (GOAWAY 未受信) に、デコードと namespace-scoped Redirect の検証を通る `REQUEST_ERROR` を受けたとき、次が成り立つこと。上記を `src/session/namespaceLoops.test.ts` で固定する (実 `SessionImpl` を使うハーネスの `getClosedWithError` / `getSessionNotifiedErrors`、`writerClosed()` / `isReadableCancelled()` で確かめる)
  - セッションが UNEXPECTED_MESSAGE で閉じ、メッセージに `received REQUEST_ERROR after REQUEST_OK` を含む
  - リクエスト単位の `error` は 0 回、`ConnectCallbacks.error` は 1 回
  - `publishNamespace()` の resolve は 1 回、reject は 0 回
  - writer が abort され、readable が cancel される
- 既存のテスト「GOAWAY 後の REQUEST_ERROR は通知しない」と、確立前の `REQUEST_ERROR` / 不正な Redirect のテストが変えずに通ること
- 契約の記述を直すこと
  - `src/session/publicTypes.ts` の `NamespacePublicationCallbacks.error` の JSDoc の 1 項目目を「確立前に、デコードと namespace-scoped Redirect の検証を通った `REQUEST_ERROR` を受けたとき」に限定する (既存の「ただしこの `PUBLISH_NAMESPACE` の要求ストリームで GOAWAY を受信した後の `REQUEST_ERROR` は無視するため呼ばない」は確立前にも当てはまるため残す)。そのうえで「確立後の `REQUEST_ERROR` では呼ばない。この要求ストリームで GOAWAY を受信した後は無視する。それ以外はセッションを閉じる (デコードと namespace-scoped Redirect の検証を通ったものは §4.1 の 2 通目の応答として UNEXPECTED_MESSAGE、通らないものはそのデコード / 検証の失敗のコード。例: Redirect の Track Name が非空なら INVALID_FIELD)」と書き足す
  - `docs/LOW_LEVEL_API.md` の「Namespace 系の扱い」の `publishNamespace()` の項目の「それ以外の `REQUEST_ERROR` と読み取り失敗では呼ぶ」を「それ以外では、読み取り失敗 (確立前後を問わない) と確立前の `REQUEST_ERROR` で呼ぶ」に直し (「それ以外では、」は節全体にかけて、セッションを閉じる原因を除く限定にする。「確立前の」は `REQUEST_ERROR` だけにかける)、「確立後の `REQUEST_ERROR` は、要求ストリームの GOAWAY 後を除き、§4.1 の 2 通目の応答として UNEXPECTED_MESSAGE でセッションを閉じる (デコードと Redirect の検証に失敗したものは従来どおりそのコードで閉じる)」と書き足す
  - `docs/HIGH_LEVEL_API.md` は既存の記述で整合しているため変えない
- `vp check` / `vp exec tsc --noEmit` / `vp test run` が通ること

`CHANGES.md` は MOQT RFC ドラフト中のため更新しない (`CODEBASE.md` の特別ルール)。

## 参照

- `src/session/namespaceLoops.ts` の `createPublicationStreamHandlers` (`onRequestOk` / `onRequestError`) / `runNamespaceStreamLoop` / `namespaceCloseRequestStreamQuiet` / `handleNamespaceRequestUpdateError`
- `src/session/namespaceLoops.test.ts` の「namespaceStartPublicationStreamLoop: 確立後の 2 通目 REQUEST_OK は重複として閉じ、reject しない」/「保留中の更新が無い REQUEST_ERROR は UNEXPECTED_MESSAGE で閉じる」/「GOAWAY 後の REQUEST_ERROR は通知しない」
- `src/session/namespaces.ts` の `namespacesPublishNamespace` / `namespacesCloseNamespacePublication`
- `src/session/lifecycle.ts` の `sessionClose` / `sessionCloseWithError`
- `src/session/publicTypes.ts` の `NamespacePublicationCallbacks` / `NamespacePublication`
- `docs/LOW_LEVEL_API.md` の「Namespace 系の扱い」、`docs/HIGH_LEVEL_API.md` の「namespace の告知 (announceNamespace)」
- open の `issues/0933-bug-subscribe-namespace-pending-settle.md` (先に対応する。同じファイルを変更する)、open の `issues/0927-bug-publish-namespace-session-closed-notification.md` (同じ JSDoc と docs の項目を変更する)、open の `issues/0930-refactor-subscription-error-notification.md` (`docs/LOW_LEVEL_API.md` の「Namespace 系の扱い」と `LOOP_CASES` を変更する。購読系の項目であり、本 issue の publication の項目とは重ならない)
- `issues/closed/0902-moqt-draft-23-specific-session-errors.md` (UNEXPECTED_MESSAGE の割り当て)、`issues/closed/0889-bug-high-level-double-on-error.md` (publication の通知の条件)、`issues/closed/0372-moqt-draft-19-duplicate-goaway-on-request-stream-undetected.md` (GOAWAY 後の `REQUEST_ERROR` を無視する扱い)
- draft-ietf-moq-transport-23 §1.5 (Response Message Naming) / §4.1 (Publishing Namespaces) / §6.4.2.3 (Request Cancellation and Rejection) / §9.2 (GOAWAY) / §9.4.2.1 (REDIRECT) / §9.5 (REQUEST_UPDATE) / §9.5.1 (Updating Subscriptions) / §12.2 (Session Termination Codes の UNEXPECTED_MESSAGE)
