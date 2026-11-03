# 確立後の REQUEST_ERROR で PUBLISH_NAMESPACE のストリームを閉じない

- Created: 2026-11-03
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-publish-namespace-request-error-stream
- Polished: {YYYY-MM-DD}

## 目的

`Session.publishNamespace()` で公開を確立した後に `REQUEST_ERROR` を受けると、publication の state を `"closed"` にして `namespacePublications` から削除するが、送信方向の writer を FIN / abort せず、受信方向の reader も cancel しない。ストリームがセッション終了まで開いたまま残る。また draft-ietf-moq-transport-22 §4.1 は PUBLISH_NAMESPACE への応答は 1 通だけであり、2 通以上を受けた publisher は protocol error でセッションを閉じる SHOULD と定めるが、2 通目の `REQUEST_ERROR` は閉じない (2 通目の `REQUEST_OK` は PROTOCOL_VIOLATION で閉じる)。

## 現状

- `src/session/namespaceLoops.ts` の `createPublicationStreamHandlers` の `onRequestError` は、`decodeRequestErrorToRequestError` の結果で `state` を `"closed"` にし、`namespaceNotifyError` を呼ぶ。確立前は `ctx.reject(error)` のあと `namespaceCloseRequestStreamQuiet` で送信方向の FIN と受信方向の cancel を行うが、確立後は何もせず `"return"` する
- `runNamespaceStreamLoop` の `finally` は `streamReader.releaseLock()` と対象 Map からの削除だけを行う
- ループの `finally` で `namespacePublications` から削除されるため、`sessionClose` が `namespacePublications` を走査しても回収できない
- `NamespacePublication.done()` は `namespacePublications` から publication を引くため、削除後はストリームを閉じられない
- 2 通目の `REQUEST_OK` は `received duplicate REQUEST_OK on PUBLISH_NAMESPACE stream` の PROTOCOL_VIOLATION でセッションを閉じるが、確立後の `REQUEST_ERROR` は閉じない。同じ「応答は 1 通だけ」の制約に対する扱いが非対称である

## 設計方針

確立後の `REQUEST_ERROR` の扱いを決める。

- draft-ietf-moq-transport-22 §4.1 の SHOULD に従うなら、2 通目の応答として PROTOCOL_VIOLATION でセッションを閉じる
- セッションを閉じない判断をするなら、少なくとも `namespaceCloseRequestStreamQuiet` 相当で送信方向を FIN、受信方向を cancel し、ストリームをセッション終了まで放置しない
- 通知の契約は `src/session/publicTypes.ts` の `NamespacePublicationCallbacks.error` の記述 (セッションを閉じる原因では `ConnectCallbacks.error` だけが通知する) と整合させる

## 完了条件

- 公開の確立後に `REQUEST_ERROR` を受けたとき、ストリームの両方向が閉じられるか、セッションが PROTOCOL_VIOLATION で閉じられる
- 上記の挙動を `src/session/namespaceLoops.test.ts` で固定する
- 契約が変わる場合は `src/session/publicTypes.ts` の JSDoc と `docs/LOW_LEVEL_API.md` を更新する
- `vp check` と `vp test --run` が通る

`CHANGES.md` は MOQT RFC ドラフト中のため更新しない (`CODEBASE.md` の特別ルール)。

## 参照

- `src/session/namespaceLoops.ts` の `createPublicationStreamHandlers` の `onRequestError` / `runNamespaceStreamLoop` の `finally` / `namespaceCloseRequestStreamQuiet`
- `src/session/namespaces.ts` の `namespacesPublishNamespace`
- `src/session/lifecycle.ts` の `sessionClose`
- `src/session/publicTypes.ts` の `NamespacePublicationCallbacks` / `NamespacePublication`
- draft-ietf-moq-transport-22 §4.1 / §9.4.2 / §9.14
