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

### 本 issue の効果範囲

本 issue で削減できるのは「対象 ID の `SubscriberPanel` が `subscriberInstances` Map 全体を購読するコスト」のみ。`App` は `subscriberIds.value` を購読しており、`Array.from(keys())` が毎回新配列を返すため Map 参照差し替え時に必ず再描画される。その結果として全 `SubscriberPanel` の関数本体は再実行される (Preact reconciler の基本挙動)。

本 issue が削減するのは関数本体実行時の「Map signal への購読登録」コストおよび「`instance` 参照が同じならば派生 signal が下流通知を起こさないことによる effect / computed の不要な再評価」である。`SubscriberPanel` 関数本体の実行回数そのものは別途 `subscriberIds` の安定化が必要であり、本 issue のスコープ外。

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
- キャッシュは `removeSubscriber` 内でも削除し、メモリリークを避ける。同 ID 再生成は ID 空間 (32 bit = `crypto.randomUUID()` 先頭 8 文字) と運用上の subscriber 数 (数十程度) から実用上無視できる。
- `removeSubscriber` 内の処理順序は **「Map 差し替え → キャッシュエントリ削除」** とする。Map 差し替え時点で cached `computed` が `undefined` への変化通知を発火させ、購読者 (`SubscriberPanel`) が `instance === undefined` を観測して `return null` で離脱する。その後でキャッシュエントリを削除する。逆順 (キャッシュ削除を先) では undefined 通知の発火経路が壊れるため不可。
- 0162 (`removeSubscriber` に decoder / session の close 集約) と組み合わせた最終形は「decoder.close → session.close → Map 差し替え → キャッシュエントリ削除」の順となる。0162 が先に実装される前提で、本 issue では `removeSubscriber` の末尾に `subscriberInstanceSignalCache.delete(id)` を追加する。

### `App.tsx` 側の処理

`App` 自体は `subscriberIds.value` を購読するため、Map 参照差し替えで再描画
される。これは「追加/削除 UI のために必要な再描画」なので残してよい。
変更するのは **子 `SubscriberPanel` 内部で起きていた無駄購読** のみ。

`subscriberIds` を `Array.from(keys())` のまま返すと毎回新しい配列で通知が必ず走るため、`App` の再描画と全 `SubscriberPanel` の関数本体再実行は本 issue では除去できない。「keys が同じなら通知しない」改善は本 issue 完了後に別 issue として SEQUENCE から番号を払い出して起票する。

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

## 関連 issue との順序

- 0162 (`removeSubscriber` に decoder / session の close 集約): 0162 → 0165 の順を前提とし、本 issue で `removeSubscriber` の末尾にキャッシュエントリ削除を追加する
- 0164 (`SubscriberInstance` の Signal 粒度再設計): 本 issue と独立。`SubscriberInstance` の中身を触らないため先後どちらでも可
- 0171 (`cleanupSubscriber` リネーム): 本 issue が触る `signals/subscriber.ts:removeSubscriber` / `SubscriberPanel.tsx` とは別ファイルのため独立

## 影響範囲

- `devtools/src/signals/subscriber.ts`
  - `getSubscriberInstanceSignal(id)` を新規追加
  - `subscriberInstanceSignalCache` を新規追加 (テスト観測用に export)
  - `removeSubscriber` の末尾でキャッシュエントリを削除 (Map 差し替えの「後」)
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
独立性を担保するため `subscriberInstanceSignalCache` を `export` し、
`beforeEach` で `subscriberInstanceSignalCache.clear()` を呼ぶ。export は
テスト観測用途で許容する (production コードからは呼ばない)。

1. `getSubscriberInstanceSignal(id)` が返す signal は、同 ID で呼び出すと
   同じインスタンスを返す (キャッシュが効く) ことを確認する。
2. `addSubscriber()` で別 ID を追加しても、既存 ID の signal に対する
   購読者は通知を受けないことを `effect` の呼び出し回数で確認する。
3. `removeSubscriber(otherId)` で別 ID を削除しても、既存 ID の signal に
   対する購読者は通知を受けないことを同様に確認する。
4. `removeSubscriber(id)` で対象 ID 自身を削除した場合、購読者が `undefined`
   への変化通知を受けることを確認する。
5. `removeSubscriber(id)` 後に `subscriberInstanceSignalCache.has(id) === false` を確認する。テスト用に `subscriberInstanceSignalCache` を export してキャッシュ状態を直接観測する (production コードでは `signal` モジュール内クローズに留めるが、テスト時の観測ヘルパとして export を許容)

加えて以下を実施する。

- `vp run test` で全テストがパスすること
- `vp run build:devtools` がエラーなく完了すること
- 手動: subscriber を 2 つ追加し、片方を `addSubscriber` / `removeSubscriber` で増減させたときに、もう片方の `SubscriberPanel` の `instanceSignal.value` 観察 effect が再評価されないことを Preact DevTools の Profiler で確認する (`SubscriberPanel` 関数本体は `App` 再描画により再実行されるが、これは本 issue のスコープ外)

## CHANGES.md 記載方針

- `### misc` サブセクションに `[UPDATE]` で記載する
  - 例: `- [UPDATE] devtools の SubscriberPanel が subscriberInstances Map 全体を購読していたのを、対象 ID 用の派生 signal だけを購読するように変更する`

## 完了条件

- `SubscriberPanel` 内に `sub.subscriberInstances.value` への直接アクセスが
  存在しない
- `signals/subscriber.ts` に `getSubscriberInstanceSignal(id)` と `subscriberInstanceSignalCache` (export) が追加されている
- `removeSubscriber` の末尾 (Map 差し替えの後) でキャッシュエントリが削除される。0162 完了後の `removeSubscriber` は「decoder.close → session.close → Map 差し替え → キャッシュ削除」の順になる
- 上記テスト戦略の単体テストが追加され、`vp run test` が全てパスする
- `vp run build:devtools` が成功する
