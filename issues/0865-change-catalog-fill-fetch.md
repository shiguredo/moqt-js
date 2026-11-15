# catalog の購読を FILL_PARAMETERS の fill fetch に変更する

- Created: 2026-10-17
- Completed: {YYYY-MM-DD}
- Branch: feature/change-catalog-fill-fetch
- Polished: 2026-11-15
- Refreshed: 2026-11-14

## 目的

MSF は catalog の取得に Joining FETCH (offset = 0) を使うことを MUST としている (draft-ietf-moq-msf-01 §5)。しかし Joining FETCH は MOQT transport draft-20 で削除され、現行の draft-23 には存在しない (draft-ietf-moq-transport-23 §A.4)。draft-23 では、SUBSCRIBE に FILL_PARAMETERS (§9.19.15) を載せて fill fetch stream (§3.4) を開かせる方法が正式な置換である。moqt-js は draft-23 を前提とするため、高レベル API の catalog の取得を fill fetch に揃える (devtools の catalog 取得は別経路であり、本 issue の対象外)。

高レベル API の現状の `subscribe()` + `fetch()` の 2 リクエストによる代替は、FETCH の応答が返らないリレーで FETCH を保留したままにする、SUBSCRIBE_OK を待ってから FETCH を送る順序制御、FETCH フェーズ中の live Object のバッファと重複除去、FETCH の終了に依存したタイムアウト処理を必要とし、経路が複雑になっている。fill fetch は購読と同じリクエストに紐づくため、これらの一部を仕様の枠組みに寄せられる。

## 現状

- `CatalogSubscription.subscribe` (`src/mediaSubscriber/catalogSubscription.ts`。`MediaSubscriberImpl.subscribeCatalog` から委譲される) は、`session.subscribe` を `filter: { nextObject: true }` (Location Filter Type 0x05) で送り、`SUBSCRIBE_OK` の後に `catalogFetchFilter` (`src/createMediaSubscriber.ts`) が返す絶対開始の Location Filter で `session.fetch` を送る。
- FETCH フェーズ中の live Object は `pendingCatalogObjects` にバッファし、FETCH 終了時に `filterPendingCatalogObjects` で重複を除去して適用する。FETCH の応答が終わらないときはタイムアウト後にバッファをドレインする。
- fill fetch の基盤は実装済みである。
  - `SubscribeOptions.fill` (`FillRequestOptions`、`src/session/publicTypes.ts`) が `buildSubscribeParameters` / `buildFillParameters` (`src/session/params.ts`) で `FILL_PARAMETERS` (0x23) として送られる。
  - セッション層は `session.fillFetchTargets` (`src/session.ts`。型 `FillFetchTarget` は `src/session/bidi.ts`) で fill fetch stream の `FETCH_HEADER` が運ぶ Request ID から購読を引く。fill 経由の Object は `MoqtObject.fillDelivered` を true にして `object` コールバックに渡る (`src/subscriber.ts`)。
  - fill の失敗はストリーム reset で通知され、`fillError` コールバックで受け取る (§3.4.1)。購読自体は継続する。
- 高レベル API の catalog 経路だけが fill を使っていない (devtools の catalog 取得は別経路であり、本 issue の対象外)。

## 設計方針

- 本 issue は高レベル API (`createMediaSubscriber`) の catalog 取得を対象とする。devtools の catalog 取得 (`devtools/src/hooks/useSubscriber.ts`) は `catalogFetchFilter` と SUBSCRIBE + FETCH を使う別経路であり、本 issue では変更しない。
- `subscribeCatalog` を 1 リクエストに変更する。`session.subscribe` に `filter: { nextObject: true }` と `fill: { filter: { startGroup: 1n } }` を渡す。これは draft-23 §3.5 の「現在の Group で join する」パターンであり、fill 範囲は最新 Group の先頭 Object から Largest Object まで、購読は次の Object から始まるため重複しない (§3.4 の exactly-once パターン)。
- fill fetch stream の Object は `fillDelivered` で区別する。fill で届いた Object は catalog の適用経路に渡し、live 購読の Object は、fill で届いた最初の完全な catalog を適用するまで `pendingCatalogObjects` にバッファする。fill と live は別ストリームで順序が保証されないため、live の delta を先に適用すると `processCatalogPayload` が delta を無視し、delta が失われる。fill の完全な catalog を適用した時点でバッファをドレインし、以降の live はそのまま適用する。
- fill の完全な catalog が購読の Promise 解決より先に届く場合がある (fill fetch stream は SUBSCRIBE_OK の処理と同じタイミングで Object を届け得る)。SUBSCRIBE_OK の後に、受信済みの完全な catalog があればタイマーを待たずに `tryResolveCatalog` で解決する。`LARGEST_OBJECT` が不明で fill 範囲が空になり fill ストリームが開かれない場合は、live の完全な catalog を適用して解決する。
- fill の失敗 (`fillError` / ストリーム reset) は購読を止めない。`fillError` を受けたらバッファをドレインし、受信済みの完全な catalog があれば解決して継続する。完全な catalog が 1 つも得られない場合だけ既存のタイムアウト経路 (`CATALOG_RECEIVE_TIMEOUT`) で失敗させる。受信タイムアウトでもバッファをドレインしてから判定する。
- `filterPendingCatalogObjects` と `catalogFetchLastLocation` は高レベル経路で不要になるため削除する。`pendingCatalogObjects` は上記の順序保証のために残す。`catalogFetchInProgress` は fill の完了待ちを表す状態に置き換える。`catalogFetchFilter` は devtools が使うため残し、`src/index.ts` の公開 export も維持する (0838 の PBT も有効なまま)。
- `filterPendingCatalogObjects` の単体テストは対象が消えるため削除する。`catalogFetchFilter` の例示テストと 0838 の PBT は devtools 用に残す。
- `src/createMediaSubscriber.media.test.ts` / `src/createMediaSubscriber.lifecycle.test.ts` / `src/createMediaSubscriber.publish-done.test.ts` の FETCH を前提にしたテスト (FETCH の開始位置 / FETCH の終了待ち / `session.fetch` の呼び出し) を fill の期待に更新する。`src/testSupport/mediaSubscriberTestSupport.ts` の `createCatalogTestSession` に fill の Object と `fillError` の制御口を足す。
- 実リレー (E2E) が fill fetch に対応しているかを確認する。既存の `tests/e2e/relay/devtools-publisher-catalog.spec.ts` は `createMediaSubscriber` で catalog を取得するため、fill 化後はこの E2E が fill の疎通確認になる。新規の E2E は追加しない。リレーが fill 未対応の場合は既存 E2E が失敗し、`start()` は `catalog receive timeout` で失敗するため、その結果を本 issue に記録する。
- `docs/HIGH_LEVEL_API.md` の「カタログの受信」と認可トークンの記述、`docs/LOW_LEVEL_API.md` の catalog 取得と認可トークンの記述、`docs/MSF.md` の catalog 取得と認可トークンの記述、`docs/IMPLEMENTATION_STATUS.md` の MSF 節と認可の記述を fill fetch に合わせて更新する。`tests/e2e/relay/devtools-publisher-catalog.spec.ts` のコメントも更新する。
- 関連 issue の前提を更新する。`issues/0835-bug-catalog-fetch-cancel.md` は catalog の FETCH が保留になる不具合であり、FETCH を送らなくなる本 issue で解消される (`cancelFetch` を低レベル API の改善として残すかは 0835 側で決める)。`issues/0836-bug-catalog-drain-error-handling.md` は FETCH フェーズの `onCatalog` の例外を扱うため、fill のドレイン経路に読み替える。`issues/0843-bug-catalog-publish-done-wait.md` は `finishCatalogFetchPhase` / `catalogFetchInProgress` を前提にしているため、本 issue は 0843 の後に対応するか、0843 の設計を fill に合わせて更新する。

## 完了条件

- 高レベル API の catalog 取得が SUBSCRIBE + FILL_PARAMETERS の 1 リクエストで完結する。
- fill fetch stream で届いた完全な catalog が live 購読より先に適用され、delta の適用順序が逆転しない。
- fill の完全な catalog が購読の Promise 解決より先に適用された場合、および `LARGEST_OBJECT` が不明で fill が開かれない場合に、タイムアウトを待たずに解決する。
- fill の失敗時にバッファをドレインし、受信済みの完全な catalog があれば解決する。fill の失敗・タイムアウト・購読の解放でハングしない。
- `filterPendingCatalogObjects` と `catalogFetchLastLocation` を削除する。`pendingCatalogObjects` は順序保証のために残す。`catalogFetchFilter` は devtools 用に残し、`src/index.ts` の公開 export も維持する。
- `docs/HIGH_LEVEL_API.md` / `docs/LOW_LEVEL_API.md` / `docs/MSF.md` / `docs/IMPLEMENTATION_STATUS.md` の catalog 取得と認可トークンの記述を fill fetch に合わせて更新する。`tests/e2e/relay/devtools-publisher-catalog.spec.ts` のコメントも更新する。
- 実リレーでの疎通を確認する。既存の `tests/e2e/relay/devtools-publisher-catalog.spec.ts` を使い、新規の E2E は追加しない。リレーが fill 未対応なら、既存 E2E が失敗し `start()` が `catalog receive timeout` で失敗することを本 issue に記録する。
- `vp check` / `vp exec tsc --noEmit` / `vp test run` が通る。

## 参照

- draft-ietf-moq-transport-23 §3.4 (Fill Semantics) / §3.4.1 (Opening and Closing Fill Fetch Streams) / §3.5 (Joining an Ongoing Track) / §9.19.15 (FILL PARAMETERS Parameter) / §A.4 (Joining FETCH 削除)
- draft-ietf-moq-msf-01 §5 (catalog の取得)
- `src/mediaSubscriber/catalogSubscription.ts` の `CatalogSubscription.subscribe` / `tryResolveCatalog` / `finishCatalogFetchPhase` / `resetCatalogFetchPhase` / `abortReceive` / `CatalogSubscriptionState` (`pendingCatalogObjects` / `catalogFetchInProgress` / `catalogFetchLastLocation`) / `src/createMediaSubscriber.ts` の `subscribeCatalog` / `handleCatalogObject` / `processCatalogPayload` / `catalogFetchFilter` / `filterPendingCatalogObjects`
- `src/index.ts` の `catalogFetchFilter` の公開 export (`src/createMediaSubscriber.ts` の `catalogFetchFilter` を再エクスポートする)
- `src/session/publicTypes.ts` の `SubscribeOptions.fill` / `FillRequestOptions`
- `src/session/params.ts` の `buildSubscribeParameters` / `buildFillParameters`
- `src/session/bidi.ts` の `FillFetchTarget` / `settleFillFetchTargetGroupOrder` / `src/session.ts` の `fillFetchTargets`
- `src/subscriber.ts` の `handleFillObject` / `fillDelivered` / `handleFillError`
- `src/session/dataStreamIncoming.ts` の `dataStreamHandleFillFetchStream` (fill ストリームの受信と失敗の経路)
- `docs/HIGH_LEVEL_API.md` の「カタログの受信」 / 認可トークン / `docs/LOW_LEVEL_API.md` の catalog 取得と認可トークン / `docs/MSF.md` の draft-23 前提と認可トークン / `docs/IMPLEMENTATION_STATUS.md` の MSF 節と認可
- `tests/e2e/relay/devtools-publisher-catalog.spec.ts` (実リレーでの catalog 取得)
- `devtools/src/hooks/useSubscriber.ts` の catalog 取得 (`catalogFetchFilter` を使う。本 issue の対象外)
- 関連: `issues/0835-bug-catalog-fetch-cancel.md` / `issues/0836-bug-catalog-drain-error-handling.md` / `issues/0838-test-catalog-fetch-filter-pbt.md` / `issues/0843-bug-catalog-publish-done-wait.md`
