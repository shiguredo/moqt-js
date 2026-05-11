# `addSubscriber` で ID 衝突を検出して再生成する

Created: 2026-05-11
Model: Opus 4.7

## 概要

`signals/subscriber.ts:addSubscriber` は `crypto.randomUUID().slice(0, 8)` で 8 桁 16 進 (32 bit 空間) の短縮 ID を生成しているが、衝突検出が無い。誕生日問題で約 77,000 個生成すると 50% で衝突する。devtools のセッション中に 77,000 subscribers を作るのは非現実的だが、HMR 連発時のリスクは皆無とは言えず、衝突時は Map に同 ID で `set` するため instance 上書きでリークする。

## 根拠

- 32 bit 空間: 4.29 × 10^9
- 誕生日問題: √(2N ln 2) ≈ 77,000
- `subscriberInstances` Map で `set` した時に同 ID があれば旧 instance が消える (該当 instance の signal は GC 対象になる) → リソースリーク経路

## 修正方針

`addSubscriber` 内で `while (newMap.has(id)) { id = ...; }` の衝突検出ループを追加する。

```typescript
export function addSubscriber(): string {
  const newMap = new Map(subscriberInstances.value);
  let id: string;
  do {
    id = `subscriber-${crypto.randomUUID().slice(0, 8)}`;
  } while (newMap.has(id));
  const instance = createSubscriberInstance(id);
  newMap.set(id, instance);
  subscriberInstances.value = newMap;
  return id;
}
```

代替案: ID を UUID v4 全長 (36 文字) にする。UI 表示用に slice(0, 8) は別途生成。

## 影響範囲

- `devtools/src/signals/subscriber.ts:addSubscriber`
- `devtools/src/signals/subscriber.test.ts` に衝突検出テストを追加 (`crypto.randomUUID` をスタブできないため確率的なテストか、内部の衝突検出関数を抽出してテスト)

## テスト戦略

- `vp run test` で全テストがパスすること
- 衝突検出ロジックを `generateUniqueSubscriberId(existing: Set<string>): string` として抽出し、`existing` に 1 個セットして同じ値を返したらリトライすることを検証

## CHANGES.md 記載方針

- `### misc` サブセクションに `[FIX]` で記載する

## 完了条件

- `addSubscriber` が ID 衝突時にリトライする
- 全テストパス
