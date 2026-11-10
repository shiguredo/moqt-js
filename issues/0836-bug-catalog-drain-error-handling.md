# catalog の FETCH フェーズ中の onCatalog の例外の扱いが経路で揃っていない

- Created: 2026-10-12
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-catalog-drain-error-handling
- Polished: 2026-11-10

## 目的

catalog の FETCH フェーズ中は、FETCH の Object の適用と、フェーズの終わりのドレイン (`finishCatalogFetchPhase`) が利用者コールバック (`onCatalog`) を呼ぶため、そこで例外が起き得る。受信タイムアウトの経路では例外を `onError` へ流してから受信タイムアウトとして失敗させるが、ほかの経路では例外が受信ループまで抜けて debug 記録だけで捨てられるか、呼び出し元の try/catch で握り潰されるか、未処理の rejection になる。いずれも `onError` が呼ばれず、フェーズの状態が解除されないまま、受信タイムアウト (5 秒) の後に受信済みのフル catalog で `onError` なしに成功することがある。FETCH フェーズ中のどの経路でも、例外を `onError` へ通知したうえで開始を失敗させる (受信タイマー以外の経路ではタイマーを待たない)。

先に open の 0843 を対応する必要がある。0843 は `rejectCatalogReceiveTimeout` を Error を受け取る `rejectCatalogReceive(error)` に一般化し、catalog の購読の `end` (エラー status の PUBLISH_DONE) からもドレインを呼ぶ。本 issue はその一般化の上で、ドレインが reject に使う Error を契機ごとに受け取る形にする。0843 の `rejectCatalogReceive` を本 issue でもこの名前で使う。

## 現状

- `src/mediaSubscriber/catalogSubscription.ts` の `CatalogSubscription.subscribe` の受信タイムアウトのコールバックは、`finishCatalogFetchPhase` を `try` で囲み、例外を `reportError` (利用者の `onError`) へ流してから `rejectCatalogReceiveTimeout` で決着させる
- FETCH の `object` コールバックは、フェーズ中に届いた FETCH の Object をドレインを経ずに `this.deps.applyObject(obj)` で即時に適用する (`MediaSubscriberImpl.handleCatalogObject` から `callbacks.onCatalog` が呼ばれる)。起動時にフル catalog が届くのは、ふつうはこの経路である。`onCatalog` の例外は `FetcherImpl.handleObject` を素通りし、`src/session/stream.ts` の `processFetchObjects` が `IncompleteDataError` 以外を投げ直すため、`src/session/dataStreamIncoming.ts` の `dataStreamHandleIncomingStream` の外側の catch から `dataStreamHandleIncomingStreamError` に入る。FETCH ストリームの処理はそこで止まり、`end` も `error` も来ない
- FETCH の `end` / `error` のコールバックは `finishCatalogFetchPhase` をそのまま呼ぶ。`finishCatalogFetchPhase` はドレインの途中で `applyObject` を呼ぶため、`onCatalog` の例外はそのまま呼び出し元へ抜ける
- `session.fetch` の Promise の reject を処理する `.catch` も `finishCatalogFetchPhase` をそのまま呼ぶ。ここで例外が出ると未処理の rejection になる
- FETCH の `end` は、`dataStreamFinishFetchStream` が呼ぶ `FetcherImpl.handleEnd` から呼ばれる。`end` コールバックが throw すると、`dataStreamFinishFetchStream` の後続の `session.fetchers.delete` / `bidi.clearPriorGapTrackingIfUnused` / `onRequestDrained` が飛ばされ、例外は受信ループの `dataStreamHandleIncomingStreamError` に入る
- `dataStreamHandleIncomingStreamError` は、すべての例外を debug に記録したうえで、`toSessionCloseError` が変換する例外 (`SessionError` / `ProtocolViolationError` / `IncompleteDataError`) ならセッションを閉じ、`MalformedTrackError` なら Track を cancel し、ピアの reset なら FETCH の状態を破棄する。利用者コールバックが投げる汎用の Error は記録だけで捨てる
- FETCH の `error` コールバックは `FetcherImpl.handleError` から呼ばれる。呼び出し元の `dataStreamHandlePeerFetchStreamReset` / `dataStreamAbortFetchOnBufferOverflow` / `src/session/bidi.ts` の `cancelMalformedTrackPeers` は `handleError` の呼び出しを try/catch で囲み、例外を握り潰す
- `finishCatalogFetchPhase` はループの前に `pendingCatalogObjects` を空にする。例外が出ると、未適用の残りは捨てられ、`catalogFetchInProgress` は true のまま残り、例外の後に届いた live だけがバッファされる。`handleCatalogObject` は `onCatalog` の前に `receivedCatalog` を代入しているため、5 秒後のタイマーの 2 回目のドレインで `tryResolveCatalog` が受信済みのフル catalog で resolve し、`start()` は `onError` なしで成功することがある (その後の `rejectCatalogReceiveTimeout` は待ちが無いので何もしない)
- live 配送経路 (`src/session/stream.ts` の `processSubgroupObjects`) は、購読のオブジェクトコールバックの例外を捕まえて `delivery.notifyError` へ渡し、`subscriber.handleError` から catalog の購読の `error` を経てアプリの `onError` に通知し、残りの配送を続ける
- `MediaSubscriberImpl.start` の catch は、開始の失敗の理由を `onError` へもう一度通知する。受信タイムアウトの経路の `onError` は、`onCatalog` の例外と `catalog receive timeout` の 2 件になる (closed の 0755 が入れた既存の扱い)

## 設計方針

- 0843 が導入する `rejectCatalogReceive(error)` を使う。ドレインは、reject に使う Error を作る関数を呼び出し元から受け取り、結果を返す: `finishCatalogFetchPhase(createFailureError: (cause: Error) => Error): CatalogDrainResult`。`CatalogDrainResult` は、`receivedCatalog` の有無ではなく、この呼び出しで待ちを resolve / reject したかで決める: `"resolved"` (この呼び出しで待ちを resolve した) / `"failed"` (この呼び出しで利用者コールバックの例外により reject した) / `"unresolved"` (例外なしで終わり、この呼び出しでは resolve しなかった)。フェーズの外で呼ばれたとき (早期 return) は何もせず (`tryResolveCatalog` も呼ばない) `"unresolved"` を返す。結果で分ける受信タイマーと 0843 の (b) は、待ちが未決着であることをドレインの前に確かめる (受信タイマーは現状の `catalogResolve === null` の検査、(b) は 0843 の決着フラグ)。Error を作るのは失敗したときだけにする
- 失敗の処理は private メソッド `failCatalogReceive(error: unknown, createFailureError: (cause: Error) => Error): void` にまとめ、ドレインと FETCH の `object` コールバックの適用の両方から使う。処理の順は次のとおりとする
  1. 例外を Error に正規化し (`error instanceof Error ? error : new Error(String(error))`)、`reportError` で `onError` へ通知する。`onError` 自体の例外は握る (通知の失敗を伝える経路がこれ以上無いため)
  2. 残りの pending オブジェクトの適用を打ち切る
  3. `rejectCatalogReceive(createFailureError(正規化した Error))` で、フェーズの状態 (`catalogFetchInProgress` / `pendingCatalogObjects` / `catalogFetchLastLocation`) の解除、`catalogReceiveFailed` の設定、catalog の待ちの reject を行う。`tryResolveCatalog` は呼ばない
- 契機ごとに渡す関数は次のとおりとする
  - 受信タイマー: `() => new Error("catalog receive timeout")` (現状どおり。既存のテスト「ドレイン中に onCatalog が throw したら onError へ通知して受信タイムアウトで失敗する」は変わらない)
  - catalog の購読の `end` (0843 の (b)): `() => publishDoneError` (`resolvePublishDoneError` の戻り値。0843 のとおり)
  - FETCH の `object` / `end` / `error` / `session.fetch` の Promise の reject を処理する `.catch`: `(cause) => new Error("catalog receive failed: callback threw", { cause })`。これらの経路では catalog を受信済みで、経過も 5000 ms 未満であり、`catalog receive timeout` (`docs/HIGH_LEVEL_API.md` と closed の 0755 では、`SUBSCRIBE_OK` から 5000 ms 以内に catalog の Object が届かなかったことを示す) を名乗らせない。適用の中で呼ばれる利用者コールバックは `onCatalog` と、decode の失敗を通知する `onError` であるため、文言は `callback threw` とする
- 受信タイマーと 0843 の (b) は、ドレインの結果で分ける
  - 受信タイマー: `"unresolved"` なら `rejectCatalogReceive(new Error("catalog receive timeout"))` を呼ぶ (現状の `rejectCatalogReceiveTimeout` の呼び出しと同じ)。`"resolved"` と `"failed"` では何もしない
  - 0843 の (b): `"resolved"` なら `handlePublishDone` で `onError` を 1 回呼ぶ。`"failed"` なら何もしない (開始の失敗の通知は `start()` の catch が行う)。`"unresolved"` なら `rejectCatalogReceive(publishDoneError)` を呼ぶ。ドレインの後に 0843 の決着フラグや `catalogResolve === null` で分けると、失敗を resolve と取り違えて PUBLISH_DONE の `onError` が 2 回になるため、ドレインの結果で分ける
- 受信タイマーの try/catch と、0843 が (b) に置くドレインの try/catch は、ドレインへ移すため削除する
- FETCH の `object` コールバックは、失敗の処理の後に例外を投げ直さない。後続の FETCH の Object は既存の `!this.state.catalogFetchInProgress` の判定で捨てられ、後から来る `end` のドレインも早期 return で何もしない。Session 層の扱い (closed の 0528 で、`processFetchObjects` の単一 sink の例外は従来どおり上位へ伝播させると決めた) は変えず、catalog の層で例外を止める。コールバックが正常に返れば、セッションが閉じる前に FIN が届いた場合に `dataStreamFinishFetchStream` の後始末 (`session.fetchers.delete` / `bidi.clearPriorGapTrackingIfUnused` / `onRequestDrained`) も実行される (開始の失敗では dispose がセッションを閉じるため、どちらが先かは競合で決まる)
- `onError` は、`onCatalog` の例外と開始の失敗 (契機ごとの Error) の 2 件になる。受信タイムアウトの経路の既存の扱いと同じである
- 5 秒後に `onError` なしで成功し得た経路を、すぐに開始の失敗にするのは意図した挙動の変更である。FETCH フェーズ中の `onCatalog` の例外は経路によらず開始の失敗とし、0755 が受信タイマーの経路で入れた扱いに揃える

### 対象外

- FETCH フェーズの後 (FETCH が REQUEST_ERROR や end で終わり、フル catalog が無いまま live を待つ間) に live の `onCatalog` が throw する経路。live 配送経路 (`processSubgroupObjects` の `notifyError`) が `onError` へ通知し、待ちは受信タイムアウトで決着する (現状のまま)。`onError` は通知されるため本 issue の不具合 (通知されずに成功する) には当たらず、live 配送の、例外を通知して継続する契約 (closed の 0528) にも触れるため、別に扱う

## 完了条件

- FETCH フェーズ中の次の各経路で、`onCatalog` が throw したときに、ドレインまたは適用からその例外で `onError` が 1 回呼ばれ、フェーズの状態が解除され、`catalogReceiveFailed` が true になり、catalog の待ちが契機ごとの Error で reject されること
  - 受信タイマーのドレイン: `catalog receive timeout` で reject される
  - FETCH の `object` / `end` / `error` / `session.fetch` の Promise の reject を処理する `.catch`: 受信タイマーを待たずに `catalog receive failed: callback threw` で reject され、その `cause` が `onCatalog` の例外であること
  - catalog の購読の `end` (0843 の (b)): 受信タイマーを待たずに PUBLISH_DONE の Error で reject され、`end` から `handlePublishDone` が呼ばれないこと (PUBLISH_DONE の `onError` は `start()` の catch の 1 回だけ)
- FETCH の `object` / `end` / `error` のコールバックが例外を投げないこと (テストの制御口の呼び出しが throw しない)。`.catch` が未処理の rejection を残さないこと
- `onError` が throw しても決着すること (ハングしない)
- 上記の単体テストが `src/createMediaSubscriber.media.test.ts` にあること (`src/testSupport/mediaSubscriberTestSupport.ts` の `createCatalogTestSession` に FETCH の `error` と `session.fetch` の reject の制御口を足す)。0843 の (b) の経路のテストは、0843 のテストがある `src/createMediaSubscriber.publish-done.test.ts` に置く
- `docs/HIGH_LEVEL_API.md` の `### カタログの受信` に「既存のカタログを FETCH で取得している間 (FETCH の応答が終わるか、エラー status の PUBLISH_DONE が届くか、受信タイムアウトになるまで) に `onCatalog` が throw すると、例外を `onError` へ通知したうえで `start()` が失敗する。FETCH で届いたカタログの適用と FETCH の終わり (応答の終わり、エラー、FETCH の拒否) では、受信タイムアウトを待たずに `catalog receive failed: callback threw` (`cause` に例外) で失敗する。エラー status の PUBLISH_DONE では PUBLISH_DONE の Error で失敗する。受信タイムアウトでは `catalog receive timeout` で失敗する」旨を書き、`#### それ以外の Error` に `catalog receive failed: callback threw` (`cause` に例外) を足すこと
- `vp check` / `vp exec tsc --noEmit` / `vp test run` が通ること

`CHANGES.md` は MOQT RFC ドラフト中のため更新しない (`CODEBASE.md` の特別ルール)。

## 参照

- `src/mediaSubscriber/catalogSubscription.ts` の `CatalogSubscription.subscribe` (FETCH の `object` / `end` / `error` のコールバック、受信タイマー、`session.fetch` の `.catch`) / `finishCatalogFetchPhase` / `rejectCatalogReceive` (0843 で `rejectCatalogReceiveTimeout` から一般化) / `tryResolveCatalog` / `resetCatalogFetchPhase`
- `src/createMediaSubscriber.ts` の `handleCatalogObject` / `subscribeCatalog` (`CatalogSubscription.subscribe` への wrapper) / `start` / `resolvePublishDoneError`
- `src/session/dataStreamIncoming.ts` の `dataStreamHandleIncomingStream` / `dataStreamFinishFetchStream` / `dataStreamHandleIncomingStreamError` / `dataStreamHandlePeerFetchStreamReset` / `dataStreamAbortFetchOnBufferOverflow`
- `src/session/errors.ts` の `toSessionCloseError` / `toProtocolViolationSessionError`
- `src/session/stream.ts` の `processFetchObjects` / `processSubgroupObjects` / `SubgroupDeliveryHooks.notifyError`
- `src/session/incoming.ts` の `notifyError` (`subscriber.handleError` への配線)
- `src/session/bidi.ts` の `cancelMalformedTrackPeers`
- `src/fetcher.ts` の `FetcherImpl.handleObject` / `FetcherImpl.handleEnd` / `FetcherImpl.handleError`
- `src/createMediaSubscriber.media.test.ts` の `subscribeCatalog` のテストと `src/testSupport/mediaSubscriberTestSupport.ts` の `createCatalogTestSession` (制御口)、`src/createMediaSubscriber.publish-done.test.ts` (0843 のテスト)
- `docs/HIGH_LEVEL_API.md` の `### カタログの受信` / `#### それ以外の Error`
- open の `issues/0843-bug-catalog-publish-done-wait.md` (先に対応する。`rejectCatalogReceive(error)` への一般化と、catalog の購読の `end` からのドレイン)
- open の `issues/0835-bug-catalog-fetch-cancel.md` (FETCH が応答しない場合。ドレインで resolve した後の FETCH の破棄)
- open の `issues/0865-change-catalog-fill-fetch.md` (fill fetch 化で FETCH の `end` / `error` / `.catch` の経路が変わる)
- `issues/closed/0755-bug-media-subscriber-catalog-timeout-devtools-publisher.md` (受信タイムアウトのドレインで onCatalog の例外を onError へ流してから失敗させる既存の扱い)
- `issues/closed/0528-bug-fanout-error-continue.md` (Session 層では FETCH の単一 sink の例外を上位へ伝播させる判断)
