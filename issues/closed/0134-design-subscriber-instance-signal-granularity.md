# `subscriberInstances` の Map 全置換更新を粒度の細かい signal に変更する

Created: 2026-05-10
Completed: 2026-05-10
Model: Opus 4.7

## 概要

`devtools/src/signals/subscriber.ts` の `updateSubscriber` (136-143 行目) は更新ごとに `Map` を新規作成して `subscriberInstances` signal を上書きしている。
`SubscriberPanel` (42 行目) は `sub.subscriberInstances.value.get(subscriberId)` でインスタンスを参照するため、いずれかの Subscriber の任意フィールドが変わっただけで **全 SubscriberPanel が再描画される**。

さらに `hooks/useSubscriber.ts` の `handleObject` (101-201 行目) は 1 オブジェクト受信あたり最大 4 回 `updateSubscriber` を呼ぶ (`objectsReceived`/`bytesReceived`/`currentGroup`/`currentSubGroup`/`decoderState`、`objectsWithExtensions`、`chunksCreated`、`chunksDecoded`/`chunksSkipped`/`keyFramesDecoded` のいずれか)。

## 根拠

- @preact/signals は本来「変更されたフィールドに依存する箇所だけを更新する」ことが利点だが、現在の Map 全置換アーキテクチャはこの利点を完全に潰している。
- Subscriber を複数追加した場合、1 つの Subscriber に届くデータで他の Subscriber も毎フレーム再描画される。
- Publisher 側は 21 個の個別 signal (`devtools/src/signals/publisher.ts`) で管理しており、Subscriber 側とは根本的に異なる設計になっている。
- 本 issue は signal の設計の一貫性と正しいリアクティブパターンの適用を目的とする。

## 修正方針

`SubscriberInstance` のミュータブル状態を `Signal<...>` のフィールドを持つオブジェクトに変える (個別 signal 案)。

### 型定義

```typescript
interface SubscriberInstanceSignals {
  id: string; // signal 不要 (不変)
  session: Session | null; // signal 不要 (参照の管理)
  subscriber: Subscriber | null; // signal 不要 (参照の管理)
  catalogSubscriber: Subscriber | null; // signal 不要 (参照の管理)
  catalog: Catalog | null; // signal 不要 (参照の管理)
  decoder: VideoDecoder | null; // signal 不要 (参照の管理)
  decoderConfigured: boolean; // signal に変更
  status: StatusType; // signal に変更
  statusMessage: string; // signal に変更
  codec: string; // signal に変更
  isStopping: boolean; // signal に変更
  joiningFetchEnabled: boolean; // signal に変更
  newGroupRequestEnabled: boolean; // signal に変更

  // 統計 (全て signal に変更)
  framesDecoded: Signal<number>;
  keyFramesDecoded: Signal<number>;
  objectsReceived: Signal<number>;
  currentGroup: Signal<number>;
  currentSubGroup: Signal<number>;
  bytesReceived: Signal<number>;
  objectsWithExtensions: Signal<number>;
  chunksCreated: Signal<number>;
  chunksDecoded: Signal<number>;
  chunksSkipped: Signal<number>;
  decodeErrors: Signal<number>;
  decoderState: Signal<string>;

  // Joining Fetch (signal に変更)
  joiningFetchStats: Signal<JoiningFetchStats>;
  largestLocation: Signal<{ group: bigint; object: bigint } | null>;
  joiningFetchInProgress: Signal<boolean>;
  liveObjectBuffer: Signal<MoqtObject[]>;
  joiningFetchLastLocation: Signal<{ group: bigint; object: bigint } | null>;
}
```

### 変更内容

1. `subscriberInstances` は `Map<string, SubscriberInstanceSignals>` のままでよい (要素追加/削除のみで再生成、フィールド更新では再生成しない)。
2. `updateSubscriber` を削除し、各フィールドの `.value` を直接代入する方式に変更する。
3. `useSubscriber` 側は `instance.objectsReceived.value++` のように増分更新する。
4. `handleObject` 内の複数回の signal 更新は、signal の `.value` 直接代入に変更することで Map コピーが不要になるため、まとめる必要がなくなる。

### API 変更

- `updateSubscriber`: 削除 (各フィールドの `.value` 直接代入に置き換える)
- `getSubscriber`: 返り値型を `SubscriberInstanceSignals | undefined` に変更
- `addSubscriber`: `SubscriberInstanceSignals` を生成するファクトリに変更
- `removeSubscriber`: 変更不要

## 依存関係

- 0142 (DebugPanel の reverse copy 排除) より先に実装する。0142 実装後は `generateSubscriberStatsText` 内の `instance.objectsReceived` 等が `.value` 経由に変更されるため、本 issue の変更範囲に含まれる。

## 影響範囲

- `devtools/src/signals/subscriber.ts`: 型定義、ファクトリ関数、`updateSubscriber` 削除
- `devtools/src/hooks/useSubscriber.ts`: `updateSubscriber` 呼び出しを `.value` 直接代入に変更
- `devtools/src/components/SubscriberPanel.tsx`: `instance.framesDecoded` → `instance.framesDecoded.value` 等の参照変更
- `devtools/src/components/DebugPanel.tsx`: `generateSubscriberStatsText` (283-341 行目) の `.value` 参照変更
- `devtools/src/testApi.ts`: `getSubscribers` / `getSubscriber` のマッピングで `.value` 経由に変更

## テスト戦略

- signal の独立性: 複数 Subscriber の signal が独立していることを検証する単体テスト
- `testApi.ts`: `getSubscribers` / `getSubscriber` の戻り値が正しいことを検証する単体テスト

## CHANGES.md 記載方針

- `### misc` サブセクションに `[CHANGE]` で記載する (他 issue 群とまとめて 1 エントリにまとめる)。

## 完了条件

- `updateSubscriber` 関数が削除されている
- `SubscriberInstanceSignals` の型定義が存在する
- 全ての `updateSubscriber` 呼び出し箇所が `.value` 直接代入に変更されている
- `SubscriberPanel` の全フィールド参照が `.value` 経由になっている
- `testApi.ts` の `getSubscribers` / `getSubscriber` が `.value` 経由で値を取得している
- `subscriberIds` / `hasActiveSubscriber` computed が引き続き動作する
- テストが全てパスする

## 解決方法

- `SubscriberInstance` を全フィールド `Signal` 化したオブジェクトに変更した
  - 仕様で「signal 不要 (参照管理)」とされていた `session` / `subscriber` / `catalogSubscriber` / `catalog` / `decoder` も `Signal` 化した
    - `hasActiveSubscriber` computed が `instance.subscriber` を参照しており、Signal 化しないと参照変化を追跡できないため
    - `publisher.ts` 側も全フィールド signal で運用しており、設計の一貫性を取るため
- `updateSubscriber` を削除し、各フィールドの `.value` 直接代入に置き換えた
- `useSubscriber` / `SubscriberPanel` / `DebugPanel` (`generateSubscriberStatsText`) / `testApi` の参照箇所を `.value` 経由に書き換えた
- `vp run build` / `vp run build:devtools` / `vp test` (456 passed) が通ることを確認した
