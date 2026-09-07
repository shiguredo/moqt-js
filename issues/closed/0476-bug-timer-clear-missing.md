# fetcher 待機と publisher ストリーム close のタイマー解放漏れ

- Created: 2026-09-06
- Completed: 2026-09-07
- Branch: feature/fix-timer-cleanup
- Polished: 2026-09-06

## 目的

確定済み Promise のタイマーが最大 5 秒残存し、高頻度発生時に蓄積する。確定時に解放する必要がある。

## 現状

- `src/session/incoming.ts` の `incomingWaitForFetcher` の 5 秒フォールバックが早期解決時に `clearTimeout` されない (多重解決防止フラグはある)。タイマーは `FETCH_OK` よりデータストリームが先着した並び替え時のみ生成される。
- タイムアウト先行発火時は `fetcherReadyCallbacks` の登録が残り、後続 `FETCH_OK` まで stale になる。セッション close 時も待機コールバック発火のみでタイマーは残る。
- `src/session/publish.ts` の `publishClosePublisherStreamInternal` の `writer.close` タイムアウトが早期成功時に解放されない (フラグなし、`Promise.race` 依存)。
- `goawayTimeoutId` 系は `clearTimeout` 済みのため対象外である。タイマーは最大 5 秒で発火消滅する一時的残留であり、無限リークではない。

## 設計方針

1. 両箇所でタイマーハンドルを保持し、確定時 (早期解決・成功・タイムアウト発火・セッション close) に `clearTimeout` する。
2. タイムアウト先行発火時は `fetcherReadyCallbacks` の登録も解除する。
3. 回帰テストは実時間の短い timeout で行う。モック / スタブは使わない (`0366` と同一方針)。

## 完了条件

- 確定時にタイマーが残存しないこと (早期解決・タイムアウト発火・close の各経路。検証は実時間の短い timeout で行い、モック / スタブは使わない)。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 解決方法

- 両箇所でタイマーハンドルを保持し、確定時に解放する。タイムアウト先行発火時は登録も解除し、broadcast 側は複製反復で欠落を防ぐ。打ち切り時は abort で後始末する
- 実時間の短い timeout のテスト 8 件を追加した。旧コードで落ちることを確認した
- `CHANGES.md` の `## develop` に `[FIX]` を追記した
