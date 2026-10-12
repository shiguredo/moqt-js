# catalog の FETCH が応答しないまま保留になり、取り消す経路が無い

- Created: 2026-10-12
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-catalog-fetch-cancel

## 目的

受信タイムアウトのドレインで live の catalog を使って開始を続けた場合、その catalog の FETCH は `FETCH_OK` を受けるまで保留のまま残る。`Fetcher` を取得できないため `Fetcher.cancel()` も呼べず、購読 (またはセッション) が終わるまで双方向ストリームと保留のエントリを保持し続ける。応答が返らない要求を購読の寿命まで残さないようにする。

## 現状

- `createMediaSubscriber` の `subscribeCatalog` は `this.session.fetch(...)` の戻り値を捨てている (`void` で起動する)。`Session.fetch()` は `FETCH_OK` の受信で解決するため、応答が返らない場合は `Fetcher` を取得できず、`Fetcher.cancel()` を呼ぶ機会が無い
- `rejectCatalogReceiveTimeout` は、ドレインで resolve した場合にフェーズの状態だけを解除し、FETCH の要求はそのままにする。フェーズ終了後の FETCH オブジェクトは破棄する (`subscribeCatalog` の FETCH の object コールバック) ため、受信した内容は使われないまま要求だけが残る
- 変更前は受信タイムアウトが必ず失敗し、開始の巻き戻し (dispose) がセッションを閉じていたため、この要求は短命だった
- 保留のまま残る要求は `src/session/lifecycle.ts` の `pendingFetch` に残り続ける

## 設計方針

- 保留の FETCH を破棄する経路を用意する。`Fetcher` を取得できていない (`FETCH_OK` 前の) 要求も対象にするため、要求 ID で `pendingFetch` を引いてキャンセルできる低レベル API を足す (draft-ietf-moq-transport-22 §3.2.4 の打ち切り = STOP_SENDING を送る既存の経路に乗せる)
- `subscribeCatalog` はドレインでフェーズを終えた時点で、その FETCH の要求を破棄する。`FETCH_OK` 後に取得できた `Fetcher` がある場合は `cancel()` を使う
- 応答が返らないこと自体は異常ではない (実測: フィルタ無しの FETCH には 21.5 秒間応答が返らない) ため、エラーとして通知しない。破棄したことは debug コールバックに残す
- テストは `src/createMediaSubscriber.test.ts` の合成セッションの制御口で固定する (FETCH が解決しないままドレインで resolve した場合に、追加した破棄の経路が呼ばれること)

## 完了条件

- ドレインで catalog を resolve した後、その FETCH が保留のまま残らない (テストで固定する)
- `FETCH_OK` を受けた後に破棄する場合は `Fetcher.cancel()` が呼ばれる
- 応答が返らない FETCH の破棄で `onError` を呼ばない (異常ではないため)
- `vp check` / `tsc --noEmit` / `vp test run` / 実リレーの E2E が通る

## 参照

- `src/createMediaSubscriber.ts` の `subscribeCatalog` / `rejectCatalogReceiveTimeout` / `finishCatalogFetchPhase`
- `src/session/requests.ts` の `requestsFetch` / `requestsCancelFetch`
- `src/fetcher.ts` の `FetcherImpl` (`cancel`)
- `src/session/lifecycle.ts` の `pendingFetch`
- draft-ietf-moq-transport-22 §3.2.4 (キャンセルは STOP_SENDING で行う)
