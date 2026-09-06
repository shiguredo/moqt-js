# Catalog 取得失敗後の状態 hygiene を正す

- Created: 2026-09-06
- Completed: YYYY-MM-DD
- Branch: feature/fix-catalog-fetch-hygiene
- Polished: YYYY-MM-DD

## 目的

`start()` が reject 済みでも遅延オブジェクトの処理が続き、`subscribe` 失敗時にフェーズ状態が残存する。失敗後の遷移を明示的にする必要がある。

## 現状

- `src/createMediaSubscriber.ts` の 5 秒タイムアウトは解決待ちを null 化するが、その後の FETCH / live オブジェクトは処理され続け、`receivedCatalog` 更新と `onCatalog` 発火が起きる。
- `session.subscribe` 自体の throw 時にフェーズフラグと空バッファがタイムアウトまで残る。
- 無害化はされているが遷移が暗黙的である。

## 設計方針

1. 失敗確定後の遅延オブジェクトを破棄し、フェーズ状態を即時掃除する。
2. `subscribe` throw 時の巻き戻しを追加する。

## 完了条件

- 失敗後に状態が残存せず、遅延処理が起きないこと。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。
