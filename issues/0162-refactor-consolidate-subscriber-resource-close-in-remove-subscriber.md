# Subscriber リソース close を `removeSubscriber` に集約する

Created: 2026-05-11
Model: Opus 4.7

## 概要

issue #0144 で `devtools/src/App.tsx:handleRemoveSubscriber` 内に `instance.decoder.value?.close()` と `instance.session.value?.close()` を直接書いたが、`removeSubscriber` の呼び出し元 (現状は `App.tsx` のみ) に「Map から削除する前に外部リソースを fire-and-forget で閉じる」というプロトコルが暗黙に要求される設計になっており、知識が `App.tsx` と `useSubscriber.ts:cleanupSubscriber` に二重化している。

本 issue では `signals/subscriber.ts:removeSubscriber` の責務を「Map からの削除」から「Map からの削除 + 当該 instance が保持する外部リソース (`decoder` / `session`) の fire-and-forget close」に拡張し、`App.tsx:handleRemoveSubscriber` を `sub.removeSubscriber(id)` の呼び出しだけにする。

## 根拠

- `App.tsx:15-29` (`handleRemoveSubscriber`) は `sub.getSubscriber(id)` から `instance` を取り出し、`decoder.close()` と `session.close()` を fire-and-forget で呼んだのち `sub.removeSubscriber(id)` を呼ぶ。同等のリソース close は `useSubscriber.ts:cleanupSubscriber` (604-657 行) でも実装されており、知識が分散している。
- 呼び出し元 (`App.tsx`) に「Map 削除前に必ず close を呼ぶ」という暗黙のプロトコルがあり、将来 `removeSubscriber` の呼び出し元が増えるとリーク再発の温床になる。`signals/subscriber.ts:subscriberInstances` を所有しているのは `signals/subscriber.ts` なので、Map から外す責任と外す対象の所有リソースを解放する責任は同じ場所に置くのが妥当。
- 0144 で `handleRemoveSubscriber` が close を呼ぶようになったあとも、Remove ボタンは `SubscriberPanel.tsx` で `disabled={isSubscribing}` ガードされているため、Remove 押下時点では subscribe 経路 (`startSubscribing` の catch / `stopSubscribing` の finally / session の close コールバック / subscriber の end コールバック) のいずれかで `cleanupSubscriber` が既に走り終わっている前提だった。しかし `cleanupSubscriber` 完了前に `instance.session.value` / `instance.decoder.value` のみ非 null で残るレース (例: `stopSubscribing` の `await unsubscribe()` 中の Remove) の可能性は完全には排除できず、close 責任を所有者側に集約しておくことで「呼び出し元が知らないと壊れる」状態を解消する。

## 修正方針

### 1. `signals/subscriber.ts:removeSubscriber` を拡張する

現状の実装:

```typescript
export function removeSubscriber(id: string): void {
  const newMap = new Map(subscriberInstances.value);
  newMap.delete(id);
  subscriberInstances.value = newMap;
}
```

を以下のように変更する:

```typescript
export function removeSubscriber(id: string): void {
  const instance = subscriberInstances.value.get(id);
  if (instance) {
    // decoder → session の順で fire-and-forget close する。
    // 0144 で `App.tsx:handleRemoveSubscriber` に置いた close 処理を
    // 所有者である `signals/subscriber.ts` 側へ移す。
    try {
      instance.decoder.value?.close();
    } catch {
      // 既にクローズ済みなら無視
    }
    instance.session.value?.close().catch(() => {
      // 既にクローズ済みなら無視
    });
  }
  const newMap = new Map(subscriberInstances.value);
  newMap.delete(id);
  subscriberInstances.value = newMap;
}
```

- close の順序は `useSubscriber.ts:cleanupSubscriber` と揃え、decoder → session とする。
- close は fire-and-forget。close 完了を待たずに Map から削除し、その後の状態リセットは行わない (Map から外した時点で当該 instance を観測する経路は存在しなくなる)。
- `decoder.value` / `session.value` を null へリセットしない。Map から削除されれば `subscriberIds` から消え、`SubscriberPanel` がアンマウントされるため、signal の値を null へ書き戻しても観測者がいない。`cleanupSubscriber` が同時並行で走っていれば null 化はそちらが担当する。

### 2. `App.tsx:handleRemoveSubscriber` を最小化する

```typescript
function handleRemoveSubscriber(id: string): void {
  sub.removeSubscriber(id);
}
```

`getSubscriber` の呼び出し・close 処理を削除する。

### 3. `useSubscriber.ts:useEffect` cleanup は本 issue では変更しない

- 既存の `useEffect(() => () => cleanupSubscriber(), [])` は 0144 で導入した予期しないアンマウント経路 (HMR / ルーティング変更等) 向けの補助で、本 issue の責務再編とは独立。
- 内部のコメント文面や `cleanupSubscriber` 自体のリネーム・分割は issue #0171 で扱う。本 issue では触らない。

## 二重 close / 二重 cleanup についての整理

`removeSubscriber` に close を移しても、以下の経路で `decoder.close` / `session.close` が複数回呼ばれる可能性は残る。いずれも fire-and-forget + try/catch で握りつぶしているため副作用はなく、現状の 0144 実装と等価。

- 経路 A: Remove ボタン押下 → `removeSubscriber` 内で close → Map 削除 → SubscriberPanel アンマウント → `useSubscriber` の useEffect cleanup → `cleanupSubscriber` → `getSubscriber` が undefined を返し no-op。
- 経路 B: `stopSubscribing` の `await unsubscribe()` 中に Remove が押された場合 (現状の `SubscriberPanel.tsx` のガード上 `isSubscribing` 中は Remove が押せないが、ガードのタイミング次第ですり抜ける可能性は残る)、`cleanupSubscriber` が finally 句で走り、`removeSubscriber` 内の close と競合する。両者とも `decoder.close()` / `session.close()` を呼ぶが、複数回呼ばれた際の同期例外は try/catch で、Promise reject は `.catch(() => {})` で吸収される設計のため、観測される副作用は無い。
- 経路 C: `session.close()` が同期的に close コールバックを発火させる WebTransport 実装の場合、`cleanupSubscriber` が再入する。これは現状の `cleanupSubscriber` でも `session.value = null` を close 前に書く対策を取っており、本 issue では変更しない。

二重実行に伴う `status` / `statusMessage` の不定問題は別途 issue #0163 で扱う。本 issue は close 呼び出しの所有者を移すスコープに限定する。

## 影響範囲

- `devtools/src/signals/subscriber.ts:removeSubscriber` の実装変更 (既存の `type` 限定 import は `.close()` 呼び出しでは実行時に解決不要のため変更不要)
- `devtools/src/App.tsx:handleRemoveSubscriber` の簡素化
- `devtools/src/signals/subscriber.test.ts` のテスト追加

`useSubscriber.ts` の `cleanupSubscriber` 本体は本 issue では変更しない (0171 のスコープ)。

## テスト戦略

CLAUDE.md の「モックやスタブは利用しないこと」を厳格に守るため、`removeSubscriber` の close 呼び出しを直接検証するテストは追加しない。代わりに以下の振る舞いを `signals/subscriber.test.ts` に追加する:

- 「`removeSubscriber` は `decoder.value` / `session.value` が null のときに例外を投げない」(現状でも成立するが、本 issue で close を呼ぶ分岐が増えるため明示的にカバーする)
- 「`removeSubscriber` は instance が存在しない `id` でも例外を投げず Map サイズを維持する」(現状の 73 行目テストの拡張として確認のみ)

実 `DecoderWrapper` / `Session` に対する close 呼び出しの確認は手動確認 (Remove → DevTools Network タブで WebTransport 接続が閉じる) と既存の 0144 リグレッションでカバーする。スタブを許容しない以上、自動テストで close 呼び出しを観測する手段はない点を明記する。

`vp run test` で全テストがパスすることを完了条件とする。

## CHANGES.md 記載方針

- `### misc` サブセクションに `[CHANGE]` で記載する (devtools 内部 API の責務再編、後方互換なし)
- エントリ例:

```
- [CHANGE] devtools の `removeSubscriber` に decoder / session の fire-and-forget close を集約する (#0162)
```

## 完了条件

- `signals/subscriber.ts:removeSubscriber` 内で `decoder.value?.close()` と `session.value?.close()` が fire-and-forget で実行される
- `App.tsx:handleRemoveSubscriber` が `sub.removeSubscriber(id)` の 1 行になる
- `signals/subscriber.test.ts` のテストが上記方針に従って更新されている
- 全テストパス
