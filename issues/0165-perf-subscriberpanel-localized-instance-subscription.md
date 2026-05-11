# `SubscriberPanel` の `subscriberInstances` Map 全体購読を局所化する

Created: 2026-05-11
Model: Opus 4.7

## 概要

`devtools/src/components/SubscriberPanel.tsx:41` の `sub.subscriberInstances.value.get(subscriberId)`
は Map signal 本体を購読しているため、Subscriber の追加/削除のたびに
**全ての** `SubscriberPanel` 関数本体が再実行される。issue #0134 が解消したのは
「フィールド更新による Map 再生成」であり、本 issue は残った「要素追加/削除に
よる Map 参照差し替えで全 panel が巻き込まれる」ケースを潰す。

`devtools/src/signals/subscriber.ts` に「特定 ID 用の派生 signal」を返すヘルパ
を追加し、`SubscriberPanel` 側はその派生 signal だけを購読する形に変更する。

## 根拠

### 現状の購読構造

- `App.tsx:32` は `sub.subscriberIds.value` を購読する。
  `subscriberIds` は `computed(() => Array.from(subscriberInstances.value.keys()))`
  で実装されている (`signals/subscriber.ts:150-152`)。`@preact/signals` の
  `computed` は前回出力と新出力を参照等値で比較するが、`Array.from()` は
  呼び出しごとに別の配列インスタンスを返すため、Map 参照が差し替わるたびに
  毎回必ず下流通知が走る。
- 通知を受けた `App` が再描画されると、`subscriberIdList.map((id) =>
  <SubscriberPanel key={id} subscriberId={id} ... />)` の各子 element が
  生成され、`key={id}` が一致する既存子は再マウントせず関数本体を再実行する。
- 再実行された `SubscriberPanel` は `sub.subscriberInstances.value.get(id)` を
  評価して Map signal を購読し直し、続けて取得した `instance` の各 `.value`
  も購読し直す。レンダー結果は同じでも、Preact の VDOM diff と signal の
  購読再構築のコストが N (= subscriber 数) 倍で発生する。

### 何が「再描画」か

「全 panel が DOM から作り直される」ことではなく、上記の通り「`App` 経由で
全 `SubscriberPanel` の関数本体が走り直され、その内部で参照する全 signal の
購読が張り直される」ことを指す。複数 subscriber を運用するときに、片方の
追加/削除がもう片方の VDOM diff を強制するのは無駄である。

### なぜ `subscriberInstances` Map 全体購読を `SubscriberPanel` 内に残してはいけないか

- `SubscriberPanel` は `subscriberId` を props として受け取り、それに対応する
  1 つの instance だけを描画する責務を持つ。にもかかわらず Map 全体を
  購読しているのは責務超過。
- issue #0164 で `SubscriberInstance` を view / runtime に分割するが、
  その後も「ID から instance を引き当てる」操作は残るため、その引き当てを
  局所購読化するこの issue は #0164 と独立に成立する。

## 修正方針

### 採用案: `signals/subscriber.ts` に `getSubscriberInstanceSignal(id)` を追加

`subscriberInstances` Map 全体を購読せず、特定 ID の `SubscriberInstance`
を「参照が変わったときだけ」通知する `ReadonlySignal<SubscriberInstance |
undefined>` を返す。

```typescript
// devtools/src/signals/subscriber.ts に追加
import { computed, type ReadonlySignal } from "@preact/signals";

// id ごとに computed を作ってキャッシュする。
// computed は前回出力と新出力を参照等値で比較するため、同じ instance を
// 返し続ける限り下流購読者には通知されない。
const subscriberInstanceSignalCache = new Map<
  string,
  ReadonlySignal<SubscriberInstance | undefined>
>();

export function getSubscriberInstanceSignal(
  id: string,
): ReadonlySignal<SubscriberInstance | undefined> {
  let cached = subscriberInstanceSignalCache.get(id);
  if (cached === undefined) {
    cached = computed(() => subscriberInstances.value.get(id));
    subscriberInstanceSignalCache.set(id, cached);
  }
  return cached;
}
```

- `computed` 内部では `subscriberInstances.value.get(id)` を呼ぶため、
  Map 参照が差し替わるたびに `computed` 本体は再評価される。
- ただし `computed` の出力は前回値との参照等値 (`!==`) 比較で等値ならば
  下流に通知しない (@preact/signals-core の `Computed._refresh` の仕様)。
  Subscriber を追加/削除しても **対象 ID の instance 参照は変わらない** ため、
  下流 (= `SubscriberPanel`) は通知を受けない。これが本 issue の核となる
  振る舞いである。
- キャッシュは `removeSubscriber` 内でも削除し、メモリリークを避ける。同 ID
  が再生成されることはない (ID は `crypto.randomUUID()` の先頭 8 文字、
  `signals/subscriber.ts:123`) ため、削除済み ID の signal が誤って再利用
  されるリスクはない。

### `App.tsx` 側の処理

`App` 自体は `subscriberIds.value` を購読するため、Map 参照差し替えで再描画
される。これは「追加/削除 UI のために必要な再描画」なので残してよい。
変更するのは **子 `SubscriberPanel` 内部で起きていた無駄購読** のみ。

`subscriberIds` を `Array.from(keys())` のまま返すと毎回新しい配列で
通知が必ず走るため、将来的に「keys が同じなら通知しない」改善 (例:
`computed` 内で前回配列との浅い等値判定を行う) を別 issue (#0166 候補) で
検討する余地があるが、本 issue のスコープ外とする。

### `SubscriberPanel.tsx` の変更

```typescript
import { useMemo } from "preact/hooks";
import { getSubscriberInstanceSignal } from "../signals/subscriber";

export function SubscriberPanel({ subscriberId, ... }: SubscriberPanelProps) {
  // ID が変わらない限り同じ signal を購読する
  const instanceSignal = useMemo(
    () => getSubscriberInstanceSignal(subscriberId),
    [subscriberId],
  );
  const instance = instanceSignal.value;
  if (!instance) {
    return null;
  }
  // 以下は変更なし
}
```

`useMemo` は依存配列 `[subscriberId]` のため、`subscriberId` が同じである
限り同じ `ReadonlySignal` を使い続ける。`.value` 読み出しが
`SubscriberPanel` のレンダー購読 (= Preact の `@preact/signals` 統合) に
登録される。

### 既存ヘルパ `getSubscriber(id)` の扱い

`signals/subscriber.ts:143` の `getSubscriber(id)` は同期取得用 (テストや
副作用処理から呼ぶ用途) として残す。`computed` を返す本 issue のヘルパとは
責務が異なる。

## 検討した代替案

### 案 B: `SubscriberPanel` 内で `useComputed` を使う

```typescript
const instance = useComputed(() => subscriberInstances.value.get(subscriberId)).value;
```

- `useComputed` は内部で `useMemo` + `computed` を作る。Map 参照差し替えでも
  `computed` 出力が同一なら下流通知しないため、効果は案 A と等価。
- 採用しない理由: 「ID から instance signal を引き当てる」関心は
  `signals/subscriber.ts` の責務であり、コンポーネント側に式を直書きすると
  他の利用者 (例: 将来 `SubscriberSummary` のような別コンポーネント) が
  同じ式を重複実装することになる。ヘルパ化して 1 箇所に集約する案 A を採る。

### 案 C: `subscriberInstances` を `Map<id, Signal<SubscriberInstance>>` に変える

- instance 参照を最初から signal で包むことで、Map 自体は要素追加/削除でしか
  signal にしない構造。
- 採用しない理由: 現行の `SubscriberInstance` は内部フィールドが既に signal
  化されており (issue #0134 の成果)、外側にもう 1 段 signal を被せる必然性が
  ない。追加コストに対して得るものが少ない。

## issue #0164 との関係

- #0164 は `SubscriberInstance` のフィールド構造 (view / runtime / ref) を
  再設計する issue で、Map から instance を引き当てる経路自体は変えない。
- 本 issue が変えるのは「Map → 特定 ID の instance を引き当てる際の購読粒度」
  のみで、`SubscriberInstance` の中身は触らない。
- 順序: 本 issue を先に行うと、#0164 が view と runtime を分割した後でも
  「ID → view を引き当てる」ヘルパ名を `getSubscriberViewSignal(id)` に
  改名するだけで済む。#0164 を先に行うと本 issue で扱う対象 (instance) が
  view に変わるが、本質的な購読構造は同じ。**先後どちらでも独立に実装可能** で
  あり、本 issue を先に着手する。

## 影響範囲

- `devtools/src/signals/subscriber.ts`
  - `getSubscriberInstanceSignal(id)` を新規追加
  - `subscriberInstanceSignalCache` を新規追加
  - `removeSubscriber` でキャッシュエントリを削除
  - `clearSubscriberInstanceSignalCache()` をテスト用に export
- `devtools/src/components/SubscriberPanel.tsx`
  - `sub.subscriberInstances.value.get(subscriberId)` をヘルパ呼び出しに置換
  - `useMemo` を追加
- `devtools/src/signals/subscriber.test.ts`
  - `getSubscriberInstanceSignal` の単体テストを追加
- `devtools/src/testApi.ts` は変更しない (テスト API は同期取得用の
  `getSubscriber` を使うべきで、本 issue のヘルパは UI 専用)

## テスト戦略

`devtools/src/signals/subscriber.test.ts` に以下を追加する。モック・スタブは
使わず、`effect` で通知回数を数える方式とする。

既存の `beforeEach` (`subscriberInstances.value = new Map()`) では本 issue
で導入する `subscriberInstanceSignalCache` がクリアされないため、テストの
独立性を担保する手段を 1 つ選んで `signals/subscriber.ts` に実装する:

- 案 i: `subscriberInstanceSignalCache` を `export` する (テスト専用に
  `cache.clear()` を呼べるようにする)
- 案 ii: `clearSubscriberInstanceSignalCache(): void` をテストヘルパ用に
  `export` する

実装シンプルさで案 ii を推奨する。`beforeEach` で
`clearSubscriberInstanceSignalCache()` を呼ぶ。

1. `getSubscriberInstanceSignal(id)` が返す signal は、同 ID で呼び出すと
   同じインスタンスを返す (キャッシュが効く) ことを確認する。
2. `addSubscriber()` で別 ID を追加しても、既存 ID の signal に対する
   購読者は通知を受けないことを `effect` の呼び出し回数で確認する。
3. `removeSubscriber(otherId)` で別 ID を削除しても、既存 ID の signal に
   対する購読者は通知を受けないことを同様に確認する。
4. `removeSubscriber(id)` で対象 ID 自身を削除した場合、購読者が `undefined`
   への変化通知を受けることを確認する。
5. `removeSubscriber(id)` 後に同 ID で `getSubscriberInstanceSignal(id)` を
   呼んだ場合に、新しい (前回とは別の) signal インスタンスが返ることを
   確認する。これによりキャッシュエントリが削除されたことを間接的に検証
   する。実運用では同 ID が再生成されないが、テスト用途として `addSubscriber`
   ではなく `subscriberInstances.value` を直接書き換えて削除済み ID と
   同じ ID を再投入する手順で確認してよい (`subscriber.test.ts` の既存
   `beforeEach` で `subscriberInstances.value = new Map()` を使っており、
   直接書き換えは既に許容されている)。

加えて以下を実施する。

- `vp run test` で全テストがパスすること
- `vp run build:devtools` がエラーなく完了すること
- 手動: subscriber を 2 つ追加し、片方を `addSubscriber` / `removeSubscriber`
  で増減させたときに、もう片方の `SubscriberPanel` の関数本体が再実行され
  ないことを Preact DevTools の Profiler または `console.log` を一時挿入して
  確認する

## CHANGES.md 記載方針

- `### misc` サブセクションに `[UPDATE]` で記載する
  - 例: `- [UPDATE] devtools の SubscriberPanel が subscriberInstances Map 全体を購読していたのを、対象 ID 用の派生 signal だけを購読するように変更する`

## 完了条件

- `SubscriberPanel` 内に `sub.subscriberInstances.value` への直接アクセスが
  存在しない
- `signals/subscriber.ts` に `getSubscriberInstanceSignal(id)` と
  `clearSubscriberInstanceSignalCache()` が追加されている
- `removeSubscriber` でキャッシュエントリが破棄される
- 上記テスト戦略の単体テストが追加され、`vp run test` が全てパスする
- `vp run build:devtools` が成功する
