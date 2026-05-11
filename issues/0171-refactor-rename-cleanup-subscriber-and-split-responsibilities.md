# `cleanupSubscriber` をリネームして責務を分割する

Created: 2026-05-11
Model: Opus 4.7

## 概要

`useSubscriber.ts:cleanupSubscriber` の名前は実体を表していない。実体は「subscriber の状態を初期状態へ完全リセットし、外部リソース (decoder / session) を fire-and-forget で close する」破壊的操作で、`cleanup` という語のニュアンスとは合わない。さらに「close → 状態リセット」の 2 つの責務が混ざっており、issue #0162 で `removeSubscriber` 側にリソース close を集約すると、ここから close 部分を切り出す必要が出る。

## 根拠

- `useSubscriber.ts:cleanupSubscriber` の実装が以下を含む:
  - `decoder.close()` (リソース解放)
  - `session.value = null` (signal リセット)
  - `session.close()` (リソース解放)
  - `subscriber.value = null` / `catalog.value = null` / `decoder.value = null` (signal リセット)
  - `joiningFetchInProgress / joiningFetchLastLocation / liveObjectBuffer / joiningFetchStats / largestLocation` のリセット
  - `chainRef.current = Promise.resolve()` のリセット
  - `settingsDisabled.value = false` の条件付き解除

## 修正方針

1. `cleanupSubscriber` を `teardownSubscriber` または `resetSubscriberState` にリネーム
2. 責務を 2 関数に分割:
   - `closeSubscriberResources(instance)`: decoder.close / session.close を担当 (issue #0162 で `signals/subscriber.ts:removeSubscriber` に集約する候補)
   - `resetSubscriberState(instance, chainRef)`: signal リセット + chainRef リセット + settingsDisabled 再有効化を担当
3. 元の呼び出し箇所 (close コールバック / error コールバック / stopSubscribing / startSubscribing catch / useEffect cleanup) を新名称に置き換える

## 影響範囲

- `devtools/src/hooks/useSubscriber.ts` 全体
- 呼び出し元のコメントや参照

## テスト戦略

- `vp run test` で全テストがパスすること
- `useSubscriber.test.ts` に新関数のテストを追加 (`resetSubscriberStats` は既に抽出済みなので、それと統合する余地がある)

## CHANGES.md 記載方針

- `### misc` サブセクションに `[CHANGE]` で記載する (内部 API のリネーム)

## 完了条件

- `cleanupSubscriber` がリネームされている
- close 系と reset 系の責務が分割されている
- 全テストパス
