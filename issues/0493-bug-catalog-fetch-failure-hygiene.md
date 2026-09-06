# Catalog 取得失敗後の状態 hygiene を正す

- Created: 2026-09-06
- Completed: YYYY-MM-DD
- Branch: feature/fix-catalog-fetch-hygiene
- Polished: 2026-09-06

## 目的

`start()` が reject 済みでも遅延 catalog オブジェクトが `receivedCatalog` 更新と `onCatalog` 発火を起こし、`subscribe` 失敗時にフェーズ状態とタイマーが残存する。失敗後の扱いを明示的にする必要がある。

## 現状

- タイムアウト reject 後も FETCH / live の `object` コールバック登録は残り、`handleCatalogObject` に失敗後ガードがないため `receivedCatalog` 更新と `onCatalog` 発火が起きる。タイムアウト処理自体はフェーズ状態 (`catalogFetchInProgress` / `pendingCatalogObjects` / `catalogFetchLastLocation`) を掃除する。
- `session.subscribe` の throw 時は `await` のため後続に進まず、フェーズフラグがタイムアウトまで残るうえ、タイマー解除がなく `catalogPromise` が後から reject する (未処理拒否になり得る)。

## 設計方針

1. `handleCatalogObject` に失敗後ガードを追加し、タイムアウト reject 後の `receivedCatalog` 更新と `onCatalog` 発火を止める。FETCH / live のコールバック登録解除は行わない (解除手段がないためガードで無害化する)。
2. `session.subscribe` throw 時に即時掃除する (`catalogFetchInProgress` の `false` 化、バッファ・Location のクリア、`catalogResolve` の null 化とタイマー解除)。`catalogSubscriber` は未登録のため `unsubscribe` 不要である。

## 完了条件

- タイムアウト reject 後に遅延オブジェクトが届いても `catalog` getter が更新されず、`onCatalog` が発火しないこと。
- `session.subscribe` throw 後にタイマー発火待ちなく掃除され、後続のタイマー発火で副作用がないこと (検証は実時間の短い timeout で行い、モック / スタブは使わない)。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。
