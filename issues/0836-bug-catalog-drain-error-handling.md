# catalog のドレイン中の onCatalog の例外の扱いが経路で揃っていない

- Created: 2026-10-12
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-catalog-drain-error-handling
- Polished: 2026-10-27

## 目的

catalog のドレイン (`finishCatalogFetchPhase`) は利用者コールバック (`onCatalog`) を呼ぶため、そこで例外が起き得る。受信タイムアウトの経路では例外を `onError` へ流してから受信タイムアウトとして決着させるが、FETCH の `end` の経路では例外が受信ループまで抜けて debug 記録だけで捨てられ、FETCH の `error` の経路では呼び出し元の try/catch で握り潰され、`session.fetch` の Promise の reject を処理する `.catch` では未処理の rejection になる。いずれも `onError` も出ず、フェーズの状態が解除されないまま受信タイムアウト (5 秒) まで決着が遅れる。どの経路でも同じ扱いにする。

## 現状

- `src/mediaSubscriber/catalogSubscription.ts` の `CatalogSubscription.subscribe` の受信タイムアウトのコールバックは、`finishCatalogFetchPhase` を `try` で囲み、例外を `reportError` (利用者の `onError`) へ流してから `rejectCatalogReceiveTimeout` で決着させる
- FETCH の `end` / `error` のコールバックは `finishCatalogFetchPhase` をそのまま呼ぶ。`finishCatalogFetchPhase` はドレインの途中で `applyObject` (`MediaSubscriberImpl.handleCatalogObject`) を呼び、そこから `callbacks.onCatalog` が呼ばれるため、`onCatalog` の例外はそのまま呼び出し元へ抜ける
- `session.fetch` の Promise の reject を処理する `.catch` も `finishCatalogFetchPhase` をそのまま呼ぶ。ここで例外が出ると未処理の rejection になる
- `Session.fetch` の `end` は `FetcherImpl` の `handleEnd` から `src/session/dataStreamIncoming.ts` の `dataStreamFinishFetchStream` に入る。`handleEnd` の `end` コールバックが throw すると、呼び出し元の受信ループの `dataStreamHandleIncomingStreamError` は `SessionError` / `MalformedTrackError` / ピアの reset 以外の例外を debug へ記録するだけで捨てる。さらに `dataStreamFinishFetchStream` の `session.fetchers.delete` と `onRequestDrained` も飛ばされる
- FETCH の `error` コールバックは `FetcherImpl.handleError` から呼ばれる。呼び出し元の `dataStreamHandlePeerFetchStreamReset` / `dataStreamAbortFetchOnBufferOverflow` / `cancelMalformedTrackPeers` は `handleError` の呼び出しを try/catch で囲み、例外を握り潰す
- いずれの経路でも `onError` は呼ばれず、`catalogFetchInProgress` は true のまま残り、`pendingCatalogObjects` もバッファされ続ける (決着は 5 秒後のタイマー)
- live 配送経路 (`src/session/stream.ts`) は、購読のオブジェクトコールバックの例外を捕まえて `delivery.notifyError` へ渡し、アプリの `onError` に通知している

## 設計方針

- 呼び出し元 (タイマー / `end` / `error` / `session.fetch` の Promise の reject を処理する `.catch`) ではなく、ドレイン (`finishCatalogFetchPhase`) が利用者コールバックの例外を扱う。例外は `onError` へ流し、`onError` 自体の例外は握る (通知の失敗を伝える経路がこれ以上無いため)
- 例外が出たときは、残りの pending オブジェクトの適用を打ち切り、フェーズの状態 (`catalogFetchInProgress` / `pendingCatalogObjects` / `catalogFetchLastLocation`) を解除して `catalogReceiveFailed` を立て、`rejectCatalogReceiveTimeout` で catalog の待ちを reject する (開始は失敗する)。`tryResolveCatalog` は呼ばない。これでタイマーを待たずに決着し、既存の受信タイムアウトの扱い (onCatalog の例外を onError へ流してから受信タイムアウトとして失敗する) と揃う
- フェーズの状態を解除してから呼び出し元へ返す (解除しないと以降の live のオブジェクトが永久にバッファされ、決着がタイマーまで遅れる)。解除して正常に返すことで、`end` の経路で飛ばされていた `session.fetchers.delete` / `onRequestDrained` も実行される
- タイマーの try/catch はドレインへ移すため削除する
- 例外を `onError` へ流す点を live 配送経路 (`src/session/stream.ts` の `processSubgroupObjects` / `notifyError`) と揃える。live 配送経路は残りの配送を続けるが、ドレインは上記のとおり打ち切って受信タイムアウトとして失敗させる (開始を失敗させる点は受信タイムアウトの経路と同じ)
- タイマー / `end` / `error` / `session.fetch` の Promise の reject を処理する `.catch` の各経路について、`onCatalog` が throw したときにドレインから `onError` が 1 回呼ばれ、フェーズの状態が解除され、`catalogReceiveFailed` が true になり、catalog の待ちが受信タイムアウトとして reject されることを単体テストで固定する

## 完了条件

- タイマー / FETCH の `end` / FETCH の `error` / `session.fetch` の Promise の reject を処理する `.catch` のどの経路でも、`onCatalog` の例外でドレインから `onError` が 1 回呼ばれる
- どの経路でもフェーズの状態 (`catalogFetchInProgress` / `pendingCatalogObjects` / `catalogFetchLastLocation`) が解除され、`catalogReceiveFailed` が true になり、catalog の待ちが受信タイムアウトとして reject される (受信タイムアウトのタイマーを待たない)
- `onError` が throw しても決着する (ハングしない)
- `vp check` / `tsc --noEmit` / `vp test run` / 実リレーの E2E が通る

## 参照

- `src/mediaSubscriber/catalogSubscription.ts` の `CatalogSubscription.subscribe` / `finishCatalogFetchPhase` / `rejectCatalogReceiveTimeout`
- `src/createMediaSubscriber.ts` の `handleCatalogObject` / `subscribeCatalog` (`CatalogSubscription.subscribe` への wrapper)
- `src/session/dataStreamIncoming.ts` の `dataStreamFinishFetchStream` / `dataStreamHandleIncomingStreamError` / `dataStreamHandlePeerFetchStreamReset` / `dataStreamAbortFetchOnBufferOverflow`
- `src/session/stream.ts` の `processSubgroupObjects` / `SubgroupDeliveryHooks.notifyError`
- `src/session/incoming.ts` の `notifyError` (`subscriber.handleError` への配線)
- `src/session/bidi.ts` の `cancelMalformedTrackPeers`
- `src/fetcher.ts` の `FetcherImpl.handleEnd` / `FetcherImpl.handleError`
- `src/createMediaSubscriber.media.test.ts` の `subscribeCatalog` のテストと `src/testSupport/mediaSubscriberTestSupport.ts` の `createCatalogTestSession` (制御口)
- `issues/closed/0755-bug-media-subscriber-catalog-timeout-devtools-publisher.md` (受信タイムアウトのドレインで onCatalog の例外を onError へ流してから失敗させる既存の扱い)
