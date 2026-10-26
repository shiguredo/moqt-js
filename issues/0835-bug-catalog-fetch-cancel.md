# catalog の FETCH が応答しないまま保留になり、取り消す経路が無い

- Created: 2026-10-12
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-catalog-fetch-cancel
- Polished: 2026-10-27

## 目的

受信タイムアウトのドレインで live の catalog を使って開始を続けた場合、その catalog の FETCH は `FETCH_OK` を受けるまで保留のまま残る。`Fetcher` を取得できないため `Fetcher.cancel()` も呼べず、購読 (またはセッション) が終わるまで双方向ストリームと保留のエントリを保持し続ける。応答が返らない要求を購読の寿命まで残さないようにする。

## 現状

- `src/mediaSubscriber/catalogSubscription.ts` の `CatalogSubscription.subscribe` は `this.deps.session().fetch(...)` の戻り値を捨てている (`void` で起動する)。`Session.fetch()` は `FETCH_OK` の受信で解決するため、応答が返らない場合は `Fetcher` を取得できず、`Fetcher.cancel()` を呼ぶ機会が無い
- 受信タイムアウトのコールバックは `finishCatalogFetchPhase` でバッファをドレインし、フル catalog があれば resolve する。このときフェーズの状態は解除されるが、FETCH の要求はそのままにする (`rejectCatalogReceiveTimeout` は resolve 済みなら何もしない)。フェーズ終了後の FETCH オブジェクトは破棄する (`CatalogSubscription.subscribe` の FETCH の object コールバック) ため、受信した内容は使われないまま要求だけが残る
- 変更前は受信タイムアウトが必ず失敗し、開始の巻き戻し (dispose) がセッションを閉じていたため、この要求は短命だった
- 保留のまま残る要求は `src/session.ts` の `pendingFetch` と `requestStreams` に残り続ける (`pendingFetch` の型は `src/session/requests.ts` の `RequestsSessionInternal` と `src/session/lifecycle.ts` の `SessionLifecycleInternal` が持ち、エントリは `requestsFetch` が設定する)

## 設計方針

- 要求 ID を呼び出し元へ渡す手段を用意する。`FetchCallbacks` に `requestId` コールバックを足し、`requestsFetch` が割り当てた要求 ID を送信前に呼ぶ。`CatalogSubscription` はこの ID を保持する
- 保留の FETCH を破棄する経路を用意する。`Fetcher` を取得できていない (`FETCH_OK` 前の) 要求も対象にするため、要求 ID で `pendingFetch` を引いてキャンセルできる低レベル API を足す (draft-ietf-moq-transport-22 §3.2.4 の打ち切り = STOP_SENDING を送る既存の経路に乗せる)
- `Session` に `cancelFetch(requestId: bigint): Promise<void>` を足し、`pendingFetch` にあればエントリを削除して Promise をキャンセル理由で reject し、`fetchers` にあれば `Fetcher.cancel()` を呼ぶ
- `bidiCancelFetch` だけでは `pendingFetch` のエントリと Promise が残るため、API 側で必ず掃除する
- `CatalogSubscription` は、受信タイムアウトのドレインで catalog を resolve した時点で、保持した要求 ID に対して `cancelFetch` を呼ぶ。`FETCH_OK` 後に `Fetcher` を取得済みなら `cancel()` を使う (`session.fetch` の Promise を保持し、解決した Fetcher を保持する)。ドレインが reject した場合は開始が失敗して dispose がセッションを閉じるため、追加の破棄は要らない
- 応答が返らないこと自体は異常ではない (実測: フィルタ無しの FETCH には 21.5 秒間応答が返らない) ため、エラーとして通知しない。高レベル API には debug コールバックが無いため、破棄は通知しない
- テストは `src/createMediaSubscriber.media.test.ts` の `subscribeCatalog` のテストと `src/testSupport/mediaSubscriberTestSupport.ts` の `createCatalogTestSession` の制御口で固定する
- FETCH が解決しないままドレインで resolve した場合に `cancelFetch` が呼ばれること、`FETCH_OK` 後に Fetcher が解決している場合に `cancel()` が呼ばれることを固定する
- `cancelFetch` 自体は `src/session.test.ts` で、`pendingFetch` のエントリが消え、Promise が決着し、`requestStreams` が掃除されることを固定する

## 完了条件

- ドレインで catalog を resolve した後、その FETCH が保留のまま残らない (`pendingFetch` と `requestStreams` のエントリが残らないことをテストで固定する)
- `FETCH_OK` を受けた後に破棄する場合は `Fetcher.cancel()` が呼ばれる
- `cancelFetch` で保留中の FETCH をキャンセルした場合、`session.fetch` の Promise が reject し、呼び出し元の `.catch` で処理できる (未処理の rejection にしない)
- 応答が返らない FETCH の破棄で `onError` を呼ばない (異常ではないため)
- `vp check` / `tsc --noEmit` / `vp test run` / 実リレーの E2E が通る

## 参照

- `src/mediaSubscriber/catalogSubscription.ts` の `CatalogSubscription.subscribe` / `rejectCatalogReceiveTimeout` / `finishCatalogFetchPhase`
- `src/createMediaSubscriber.ts` の `subscribeCatalog` (CatalogSubscription への wrapper)
- `src/session/requests.ts` の `requestsFetch` / `requestsCancelFetch`
- `src/session/bidi.ts` の `bidiCancelFetch`
- `src/fetcher.ts` の `FetcherImpl` (`cancel`)
- `src/session.ts` の `Session` インターフェース / `pendingFetch` / `requestStreams` (`src/session/requests.ts` の `RequestsSessionInternal` と `src/session/lifecycle.ts` の `SessionLifecycleInternal` が型を持つ)
- `src/session/publicTypes.ts` の `FetchCallbacks`
- `src/testSupport/mediaSubscriberTestSupport.ts` の `createCatalogTestSession`
- `docs/LOW_LEVEL_API.md` の `Session` のメソッド一覧 / `Fetcher`
- draft-ietf-moq-transport-22 §3.2.4 (キャンセルは STOP_SENDING で行う)
