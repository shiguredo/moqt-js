# ピア起点のセッション終了で publication のリクエスト単位通知が順序依存になる

- Created: 2026-11-03
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-publish-namespace-session-closed-notification
- Polished: 2026-11-10

## 目的

ピア起点でセッションが終了したとき、WebTransport のセッション終了起源の読み取り失敗 (`source: "session"`) は `toSessionCloseError` が null を返すため、publication の `onReadError` でリクエスト単位の `error` コールバックが呼ばれる。呼ばれるかどうかは、対象の state を `"closed"` にする終了の後始末と、ストリームの読み取り失敗のどちらが先に処理されるかで変わる。namespace / tracks の購読、request stream (bidi)、受信 PUBLISH はセッション終了起源を通知しておらず、publication だけ非対称である。高レベル API では、正常なピア close で `onError` と `onClose` が続けて呼ばれ得る。リクエスト単位の `error` を呼ぶかどうかを順序に依存させず、セッション終了起源はリクエスト単位の `error` では通知せずに `ConnectCallbacks.close` に任せる形に揃える。

先に open の 0933 (PR #543。マージ後は `issues/closed/` に移る) を対応する必要がある。0933 は同じ `src/session/namespaceLoops.ts` / `src/session/namespaceLoops.test.ts` と、`docs/LOW_LEVEL_API.md` の「Namespace 系の扱い」(`subscribeTracks()` の項目の直後に `subscribeNamespace()` / `subscribeTracks()` の送信の項目を追加する。0927 が直す `NamespacePublicationCallbacks.error` の項目はその 2 つ後) を変更するため、その後に着手して編集の衝突を避ける。

## 現状

- `src/session/errors.ts` の `isSessionClosedError` は、グローバルに `WebTransportError` があり、かつエラーがそのインスタンスのときは `source === "session"` を判定する。それ以外 (グローバルが無い Node のテスト環境と、実ブラウザでも `WebTransportError` でないエラー) は、メッセージ (`"session is closed"` / `"session closed"` を含むか) で判定する
- `src/session/namespaceLoops.ts` の `namespaceHandleSubscriptionReadError` (subscribeNamespace / subscribeTracks) は、`!isSessionClosedError(error)` のときだけ通知する。通知を抑止した場合も state を `"closed"` にし、確立前なら `ctx.reject(error)` で読み取りエラーのまま reject する
- `createPublicationStreamHandlers` の `onReadError` (publishNamespace) は、`ctx.target.state !== "closed"` かつ `!ctx.progress.goawayReceived` のとき state を `"closed"` にし、`toSessionCloseError(error) === null` なら通知する (closed の 0889 で、ライブラリが `closeWithError` でセッションを閉じる原因では通知しない形にした)。そのため `source: "session"` は通知される。確立前で GOAWAY による移行中でなければ `ctx.reject(error)` で reject する。コメントは「通知を抑止した場合も reject は維持する (未確立の publishNamespace() の待ちを sessionRejectPendingRequests の汎用エラーではなく、受信した具体的なエラーで settle させるため)」と書いている
- ループの `finally` の cleanup (`namespaceStartPublicationStreamLoop` の `session.namespacePublications.delete(requestId)`) がエントリを消すため、読み取り失敗が先に処理された場合、後から走る `sessionRejectPendingRequests` は確立前の publication に届かない。確立前の reject は `onReadError` の `ctx.reject(error)` が担っている (0889 の判断)
- `src/session/bidi.ts` の `handleRequestStreamReadError` は、`!isPeerStreamError(error)` で早期 return するため、セッション終了起源を通知しない
- 終了の後始末で state を `"closed"` にするのは `src/session/lifecycle.ts` の `sessionMarkRequestObjectsClosed` であり、`src/session.ts` の `transport.closed` の処理から呼ばれる (open の 0936 の後は、他の受信ループの `sessionNotifyErrorIfActive` が先に呼ぶ経路も加わる)。W3C WebTransport の cleanup は、受信ストリームを error にしてから `closed` を settle する。`src/session/incomingPublish.ts` の `incomingPublishRunStreamSubLoop` も「transport.closed がストリームのエラーより先に処理される順序 (state も closed になる) への防御」と書いており、どちらの順序もあり得る
- セッション終了起源 (`source: "session"`) は `ConnectCallbacks.error` には届かない。`sessionNotifyErrorIfActive` は `isSessionClosedError` で状態を閉じて返り、制御ループ (`sessionStartControlMessageLoop`) は `source` が `"session"` のエラーを通知しない。`transport.closed` の処理は `ConnectCallbacks.close` だけを呼ぶ
- `src/createMediaPublisher.ts` の `announceNamespace` は、確立後ならリクエスト単位の `error` を `callbacks.onError` に流す
- `src/session/publicTypes.ts` の `NamespacePublicationCallbacks.error` の JSDoc と `docs/HIGH_LEVEL_API.md` の「namespace の告知 (announceNamespace)」は、セッション終了処理との順序により通知され得ることを契約として書いている。`docs/LOW_LEVEL_API.md` の「Namespace 系の扱い」の `publishNamespace()` の項目は「それ以外の `REQUEST_ERROR` と読み取り失敗では呼ぶ」と書き、`source: "session"` を除外していない
- `src/session/namespaceLoops.test.ts` のテスト「namespaceStartPublicationStreamLoop: セッション終了起源の読み取り失敗は通知し得る」は、通知されることを固定している (0889 の解決方法)。テスト「namespaceStartNamespaceStreamLoop: セッション終了起源の読み取り失敗は通知しない」の JSDoc は「publication の扱いとの非対称は公開契約に明記している」と書いている
- open の 0930 は、購読系の通知の条件に `toSessionCloseError` の条件を加える (既存の `isSessionClosedError` の抑止は残す) 予定である。0927 は逆向きに、publication に `isSessionClosedError` の抑止を加える

## 設計方針

- publication の `onReadError` で、`isSessionClosedError(error)` のときは `namespaceNotifyError` だけを抑止する。state の `"closed"` 化と、確立前 (`!ctx.progress.resolved && !ctx.progress.requestMigrated`) の `ctx.reject(error)` は維持する。`namespaceHandleSubscriptionReadError` と同じ扱いであり、0889 の判断 (確立前は受信した具体的なエラーで settle させる) を引き継ぐ。ループの `finally` の cleanup がエントリを消すため、確立前の reject を `sessionRejectPendingRequests` に任せることはできない
- 通知の条件は「`isSessionClosedError(error) || toSessionCloseError(error) !== null` のときは呼ばない」になる。0889 の `toSessionCloseError` の条件は残す
- これにより、リクエスト単位の `error` を呼ぶかどうかが順序に依存しなくなる。確立前の reject の理由 (読み取りエラーか、終了の後始末の理由か) は順序に依存したままであり、これは 0933 / 0936 が前提にしている挙動である
- 高レベル API では、告知の確立後で `start()` の実行中の窓のピア起点の終了で、現状はリクエスト単位の `error` に由来する `onError` (読み取り失敗が先に処理された場合) と `start()` の失敗の `onError` の両方が呼ばれ得る。本 issue の後は前者 (告知のリクエスト単位の `error` に由来する `onError`) が消える。`start()` の失敗としての `onError` と `onClose` は従来どおりである (解放の失敗などで `onError` が加わる経路は本 issue では変えない)
- セッション終了起源はリクエスト単位の `error` では通知せず、`ConnectCallbacks.close` に任せる。契約の記述から「セッション終了処理との順序により呼ばれることがある」を削除し、「セッション終了起源 (`source: "session"`) では呼ばない」に統一する
- 0930 との関係: 購読系に `toSessionCloseError` の条件を足す作業は 0930 が扱う。0927 と 0930 のどちらが後に着手する場合も、`isSessionClosedError` と `toSessionCloseError` の両方の条件を残す (置き換えない。0930 の設計方針にも同じことを書いてある)。0930 が先に完了して購読系から `isSessionClosedError` の条件が外れていた場合は、購読系にも戻す

## 完了条件

- publication の `onReadError` で `source: "session"` の読み取り失敗を受けたとき、リクエスト単位の `error` が呼ばれず、state が `"closed"` になること。確立前なら、渡した reject が同じエラーで呼ばれること
- `source: "session"` の扱い (通知しない、`"closed"` にする、確立前は同じエラーで reject する) が `namespaceHandleSubscriptionReadError` と一致し、`toSessionCloseError` が non-null の原因を通知しない 0889 の条件が維持されていること
- `src/session/namespaceLoops.test.ts` の既存テスト「namespaceStartPublicationStreamLoop: セッション終了起源の読み取り失敗は通知し得る」を、通知 0 件、state の `"closed"`、確立前の同じエラーでの reject を固定する形に置き換え、テスト名も変えること。注入するエラーは、既存テストと同じく `"session is closed"` を含むメッセージに `source: "session"` を付ける (Node のテスト環境ではメッセージで判定されるため)。テスト「namespaceStartNamespaceStreamLoop: セッション終了起源の読み取り失敗は通知しない」の JSDoc から「非対称」の記述を削除すること
- 契約の記述を 3 か所で直すこと
  - `src/session/publicTypes.ts` の `NamespacePublicationCallbacks.error` の JSDoc: 順序による通知の記述を削除し、セッション終了起源では呼ばないと書く
  - `docs/HIGH_LEVEL_API.md` の「namespace の告知 (announceNamespace)」の「告知の確立後に `RESET_STREAM` を受けると `onError` を通知し、配信は続ける」の項目: 「セッション終了処理との順序により `onError` が呼ばれることがある (`onClose` と続けて呼ばれ得る)」を削除し、「告知の確立後のピア起点のセッション終了 (`source: "session"`) では、告知のリクエスト単位の `error` に由来する `onError` を通知しない」とだけ書く。終了の観測 (`start()` の完了後は `onClose`、`start()` の実行中に重なった場合は `start()` の失敗の `onError` と `onClose`、`stop()` が解放に相乗りした場合は `onClose` を通知しない) は「状態遷移」節の既存の記述が扱っているため、この項目には書かず、それらの記述も変えない。高レベル API 全体についての「`onClose` だけが通知される」という保証も書かない (解放の失敗などで `onError` が呼ばれる経路が残るため)
  - `docs/LOW_LEVEL_API.md` の「Namespace 系の扱い」の `publishNamespace()` の `NamespacePublicationCallbacks.error` の項目: 呼ばない条件にセッション終了起源 (`source: "session"`) を加える
- `vp check` / `vp exec tsc --noEmit` / `vp test run` が通ること

`CHANGES.md` は MOQT RFC ドラフト中のため更新しない (`CODEBASE.md` の特別ルール)。

## 参照

- `src/session/errors.ts` の `isSessionClosedError` / `toSessionCloseError`
- `src/session/namespaceLoops.ts` の `createPublicationStreamHandlers` (`onReadError`) / `namespaceHandleSubscriptionReadError` / `namespaceStartPublicationStreamLoop`
- `src/session/namespaceLoops.test.ts` の「namespaceStartPublicationStreamLoop: セッション終了起源の読み取り失敗は通知し得る」/「namespaceStartNamespaceStreamLoop: セッション終了起源の読み取り失敗は通知しない」
- `src/session/bidi.ts` の `handleRequestStreamReadError`
- `src/session/lifecycle.ts` の `sessionMarkRequestObjectsClosed` / `sessionNotifyErrorIfActive` / `sessionStartControlMessageLoop`
- `src/session.ts` の `transport.closed` の処理
- `src/session/incomingPublish.ts` の `incomingPublishRunStreamSubLoop`
- `src/createMediaPublisher.ts` の `announceNamespace`
- `src/session/publicTypes.ts` の `NamespacePublicationCallbacks.error`
- `docs/HIGH_LEVEL_API.md` の「namespace の告知 (announceNamespace)」、`docs/LOW_LEVEL_API.md` の「Namespace 系の扱い」
- `issues/closed/0889-bug-high-level-double-on-error.md` (publication の通知の条件と、確立前の reject を維持する判断)
- open の `issues/0933-bug-subscribe-namespace-pending-settle.md` (先に対応する。同じファイルを変更する)、open の `issues/0936-bug-session-notify-error-pending.md` (終了の後始末の経路が増える)、open の `issues/0930-refactor-subscription-error-notification.md` (購読系の通知の条件。逆向きの補完)
- W3C WebTransport の "cleanup a WebTransport" の手順
- draft-ietf-moq-transport-23 §6.6 (Termination)。リクエスト単位の通知の扱いを定める規定ではなく、通知の抑止はライブラリの方針である。GOAWAY 後の抑止 (`goawayReceived`、§9.2 GOAWAY) は変えない
