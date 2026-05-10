# `subscriberInstances` の Map 全置換更新を粒度の細かい signal に変更する

Created: 2026-05-10
Model: Opus 4.7

## 概要

`devtools/src/signals/subscriber.ts` の `updateSubscriber` は更新ごとに `Map` を新規作成して `subscriberInstances` signal を上書きしている。
`SubscriberPanel` は `sub.subscriberInstances.value.get(subscriberId)` でインスタンスを参照するため、いずれかの Subscriber の任意フィールドが変わっただけで **全 SubscriberPanel が再描画される**。

さらに `hooks/useSubscriber.ts` の `handleObject` は 1 オブジェクト受信あたり最大 5 回 `updateSubscriber` を呼ぶ (`objectsReceived`, `objectsWithExtensions`, `chunksCreated`, `chunksDecoded`/`chunksSkipped`, `keyFramesDecoded`)。30fps 想定で毎秒 150 回の Map コピーと全パネル再描画が発生する。

## 根拠

- @preact/signals は本来「変更されたフィールドに依存する箇所だけを更新する」ことが利点だが、現在の Map 全置換アーキテクチャはこの利点を完全に潰している。
- Subscriber を複数追加した場合、1 つの Subscriber に届くデータで他の Subscriber も毎フレーム再描画される。Publisher 側 (個別 signal) と整合がとれていない。
- フレーム到着のホットパスで `new Map(prevMap)` のコピーが走り、ヒープ圧と GC 負荷が増える。

## 修正方針

以下のいずれかで粒度を細かくする:

1. **個別 signal 案 (推奨)**: `SubscriberInstance` のミュータブル状態を `Signal<...>` のフィールドを持つオブジェクトに変える。
   - `subscriberInstances` は `Map<string, SubscriberInstanceSignals>` のままでよい (要素追加/削除のみで再生成、フィールド更新では再生成しない)。
   - `useSubscriber` 側は `instance.framesDecoded.value++` のように増分更新する。
   - Publisher と同じ粒度に揃う。

2. **Map<string, Signal<SubscriberInstance>> 案**: 各 Subscriber を 1 つの signal にまとめる。フィールド単位の追跡はできないが、Subscriber 間の独立性は確保できる。

加えて、`handleObject` 内で同一フレーム/同一オブジェクトに対して走る複数回の `updateSubscriber` 呼び出しを 1 回にまとめる (差分オブジェクトを 1 つ作って一度に適用する)。

## 影響範囲

- `devtools/src/signals/subscriber.ts`
- `devtools/src/hooks/useSubscriber.ts`
- `devtools/src/components/SubscriberPanel.tsx` (フィールド参照を `.value` 経由に変える)
- `devtools/src/components/DebugPanel.tsx` (Subscriber 統計を読む箇所)
- `devtools/src/testApi.ts` (getSubscribers / getSubscriber)
