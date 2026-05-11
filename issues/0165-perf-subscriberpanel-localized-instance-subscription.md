# `SubscriberPanel` の `subscriberInstances` Map 全体購読を局所化する

Created: 2026-05-11
Model: Opus 4.7

## 概要

`SubscriberPanel.tsx:42` の `sub.subscriberInstances.value.get(subscriberId)` は Map signal 自体を購読しており、要素追加/削除のたびにすべての `SubscriberPanel` が再描画される。これは issue #0134 の本来の意図 (Map 全置換更新を粒度の細かい signal に変更) と矛盾する。

`signals/subscriber.ts` にヘルパ (例: `getSubscriberSignal(id): Signal<SubscriberInstance | undefined>` または `computed`) を追加し、特定 ID の購読のみを SubscriberPanel が行うようにする。

## 根拠

- `SubscriberPanel.tsx:42`: `sub.subscriberInstances.value.get(subscriberId)` で Map signal を読む
- `addSubscriber` / `removeSubscriber` は Map を新規参照で置き換えるため、Map signal 変更 = 全 SubscriberPanel 再描画
- issue #0134 の解決方法は「Map は要素追加/削除のみで再生成し、フィールド更新では再生成しない」だが、要素追加/削除自体は依然全 panel 再描画を誘発する

## 修正方針

1. `signals/subscriber.ts` に以下のいずれかを追加:
   - **案 A**: `getSubscriberSignal(id): ReadonlySignal<SubscriberInstance | undefined>` を返す関数。内部で `computed` を使い、id をキーとした個別購読を提供
   - **案 B**: `SubscriberPanel` 側で `computed(() => subscriberInstances.value.get(id))` を `useMemo` か `useComputed` で構築
2. `SubscriberPanel.tsx:42` を新ヘルパ経由に変更
3. ただし `subscriberInstances` の要素追加/削除 = Map 参照差し替えなので、computed 自体は依然再評価される。完全な局所化には Map 自体ではなく `Map<id, Signal<Instance>>` 構造を検討するか、Preact-Signals の特性を踏まえた設計が必要

実装を始める前に preact-signals スキルを参照すること。

## 影響範囲

- `devtools/src/signals/subscriber.ts`
- `devtools/src/components/SubscriberPanel.tsx`

## テスト戦略

- `vp run test` で全テストがパスすること
- 手動: Subscriber を 2 つ並べた状態で片方の状態を更新 → もう片方が再描画されないことを Preact DevTools で確認

## CHANGES.md 記載方針

- `### misc` サブセクションに `[UPDATE]` で記載する

## 完了条件

- SubscriberPanel が `subscriberInstances` の Map 全体を購読しなくなる
- 全テストパス
