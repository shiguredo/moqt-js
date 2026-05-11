# `stopSubscribing` と close コールバックの `cleanupSubscriber` 再入レースを解消する

Created: 2026-05-11
Model: Opus 4.7

## 概要

`stopSubscribing` の `await subscriberInstance.unsubscribe()` 中に WebTransport の close コールバックが先行発火すると、`cleanupSubscriber` が 2 度走る経路がある。

1. `stopSubscribing` が `isStopping.value = true` を立てて `await unsubscribe()`
2. その await 中に WebTransport が閉じて close コールバック発火 → `cleanupSubscriber()` が呼ばれ session/decoder を null 化
3. `unsubscribe()` が reject (`state !== "active"`)
4. finally 句で `cleanupSubscriber()` が再度呼ばれる (冪等だが status の上書きはレース)

`status.value = "disconnected"` の上書きが close 由来か stop 由来かレースで決まり、最終 `statusMessage` が不定になる。`isStopping` は stop の二重実行防止にしか使われておらず、`cleanupSubscriber` 内では参照されない。

## 根拠

- `useSubscriber.ts:stopSubscribing` (`finally { cleanupSubscriber(); ... }`)
- `useSubscriber.ts:close` コールバック (`cleanupSubscriber();`)
- `cleanupSubscriber` は冪等性を保つよう設計されているが、`status.value` 更新は close コールバック側でも行うため競合する

## 修正方針

`cleanupSubscriber` に「クリーンアップ済みフラグ」を導入する。例えば `instance.session.value === null && instance.decoder.value === null` を「既に teardown 済み」のマーカーとして冒頭で早期 return する。または `instance.cleanedUp: Signal<boolean>` を追加する。

別解として、close コールバック内で `status` / `statusMessage` を上書きする責務を撤廃し、cleanupSubscriber に一本化する。

なお issue #0161 で AbortController を導入すると `unsubscribe()` 自体を中断できるため、本 issue と統合できる可能性がある。AbortController 化を先行させる場合は本 issue を pending にする選択肢もある。

## 影響範囲

- `devtools/src/hooks/useSubscriber.ts:stopSubscribing` / `cleanupSubscriber` / `close` コールバック

## テスト戦略

- `vp run test` で全テストがパスすること
- 偽 Session + 偽 Subscriber で「stopSubscribing 中に close 発火」シナリオを再現するテストを追加
- 手動: Stop ボタン押下と同時にサーバ切断 → status / statusMessage が不定にならず確定的に終端表示

## CHANGES.md 記載方針

- `## develop` 直下に `[FIX]` で記載する (devtools の動作に影響)

## 完了条件

- `cleanupSubscriber` の再入が無害化される
- `status` / `statusMessage` の最終値が確定する (close 経路でも stop 経路でも同じ)
- 全テストパス
