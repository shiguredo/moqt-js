# catalog の購読を FILL_PARAMETERS の fill fetch に変更する

- Created: 2026-10-17
- Completed: {YYYY-MM-DD}
- Branch: feature/change-catalog-fill-fetch
- Polished: {YYYY-MM-DD}

## 目的

MSF は catalog の取得に Joining FETCH (offset = 0) を使うことを MUST としている (draft-ietf-moq-msf-01 §5)。しかし Joining FETCH は MOQT transport draft-20 で削除され、draft-22 には存在しない (draft-ietf-moq-transport-22 §A.3)。draft-22 の正式な置換は、SUBSCRIBE に FILL_PARAMETERS (§9.20.15) を載せて fill fetch stream (§3.4) を開かせる方法である。moqt-js は draft-22 を前提とするため、catalog の取得を fill fetch に揃える。

現状の `subscribe()` + `fetch()` の 2 リクエストによる代替は、FETCH の応答が返らないリレーで FETCH を保留したままにする、SUBSCRIBE_OK を待ってから FETCH を送る順序制御、FETCH フェーズ中の live Object のバッファと重複除去、FETCH の終了に依存したタイムアウト処理を必要とし、経路が複雑になっている。fill fetch は購読と同じリクエストに紐づくため、これらの一部を仕様の枠組みに寄せられる。

## 現状

- `MediaSubscriberImpl.subscribeCatalog` (`src/createMediaSubscriber.ts`) は、`session.subscribe` を `filter: { nextObject: true }` (Location Filter Type 0x05) で送り、`SUBSCRIBE_OK` の後に `catalogFetchFilter` が返す絶対開始の Location Filter で `session.fetch` を送る。
- FETCH フェーズ中の live Object は `pendingCatalogObjects` にバッファし、FETCH 終了時に `filterPendingCatalogObjects` で重複を除去して適用する。FETCH の応答が終わらないときはタイムアウト後にバッファをドレインする。
- fill fetch の基盤は実装済みである。
  - `SubscribeOptions.fill` (`FillRequestOptions`、`src/session/publicTypes.ts`) が `buildSubscribeParameters` / `buildFillParameters` (`src/session/params.ts`) で `FILL_PARAMETERS` (0x23) として送られる。
  - セッション層は `fillFetchTargets` (`src/session/bidi.ts`) で fill fetch stream の `FETCH_HEADER` が運ぶ Request ID から購読を引く。fill 経由の Object は `MoqtObject.fillDelivered` を true にして `object` コールバックに渡る (`src/subscriber.ts`)。
  - fill の失敗はストリーム reset で通知され、`fillError` コールバックで受け取る (§3.4.1)。購読自体は継続する。
- catalog 経路だけが fill を使っていない。

## 設計方針

- `subscribeCatalog` を 1 リクエストに変更する。`session.subscribe` に `filter: { nextObject: true }` と `fill: { filter: { startGroup: 1n } }` を渡す。これは draft-22 §3.5 の「現在の Group で join する」パターンであり、fill 範囲は最新 Group の先頭 Object から Largest Object まで、購読は次の Object から始まるため重複しない (§3.4 の exactly-once パターン)。
- fill fetch stream の Object は `fillDelivered` で区別し、catalog の適用経路に渡す。最初の完全な catalog が fill で届いた時点で catalog の受信を完了できるため、FETCH の終了待ちに相当する状態をなくす。
- fill の失敗 (`fillError` / ストリーム reset) は購読を止めない。受信済みの catalog で継続し、catalog が 1 つも得られない場合だけ既存のタイムアウト経路で失敗させる。
- `catalogFetchFilter` と FETCH のバッファ・重複除去が不要になる場合は削除する。catalog の fill 化で不要になるテスト (catalogFetchFilter の PBT など) は、対象が消えるなら同時に整理する。
- 実リレー (E2E) が fill fetch に対応しているかを確認する。未対応の場合は E2E を追加せず、その結果を本 issue に記録する。

## 完了条件

- catalog の取得が SUBSCRIBE + FILL_PARAMETERS の 1 リクエストで完結する。
- fill fetch stream で届いた完全な catalog が live 購読より先に適用され、delta の適用順序が逆転しない。
- fill の失敗・タイムアウト・購読の解放でハングしない。
- 実リレーでの疎通を確認する (リレーが fill 未対応なら、その結果を issue に記録する)。
- `vp check` / `tsc --noEmit` / `vp test run` が通る。

## 参照

- draft-ietf-moq-transport-22 §3.4 (Fill Semantics) / §3.4.1 (Opening and Closing Fill Fetch Streams) / §3.5 (Joining an Ongoing Track) / §9.20.15 (FILL PARAMETERS Parameter) / §A.3 (Joining FETCH 削除)
- draft-ietf-moq-msf-01 §5 (catalog の取得)
- `src/createMediaSubscriber.ts` の `subscribeCatalog` / `catalogFetchFilter`
- `src/session/publicTypes.ts` の `SubscribeOptions.fill` / `FillRequestOptions`
- `src/session/params.ts` の `buildSubscribeParameters` / `buildFillParameters`
- `src/session/bidi.ts` の `FillFetchTarget` / `fillFetchTargets`
- `src/subscriber.ts` の fillDelivered の object コールバック
- 関連: `issues/0835-bug-catalog-fetch-cancel.md` / `issues/0836-bug-catalog-drain-error-handling.md` / `issues/0838-test-catalog-fetch-filter-pbt.md`
