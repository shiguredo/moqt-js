# Subscriber リソース close を `removeSubscriber` に集約する

Created: 2026-05-11
Model: Opus 4.7

## 概要

issue #0144 で `devtools/src/App.tsx:handleRemoveSubscriber` 内に `instance.decoder.value?.close()` と `instance.session.value?.close()` を直接書いたが、`removeSubscriber` の呼び出し元に「Map から削除する前に外部リソースを fire-and-forget で閉じる」というプロトコルが暗黙に要求される設計になっており、知識が `App.tsx` と `useSubscriber.ts:cleanupSubscriber` に二重化している。

本 issue では `signals/subscriber.ts:removeSubscriber` の責務を「Map からの削除」から「Map からの削除 + 当該 instance が保持する外部リソース (`decoder` / `session`) の fire-and-forget close」に拡張し、`App.tsx:handleRemoveSubscriber` を `sub.removeSubscriber(id)` の呼び出しだけにする。

## 根拠

- `App.tsx:15-29` (`handleRemoveSubscriber`) は `sub.getSubscriber(id)` から `instance` を取り出し、`decoder.close()` と `session.close()` を fire-and-forget で呼んだのち `sub.removeSubscriber(id)` を呼ぶ。同等のリソース close は `useSubscriber.ts:cleanupSubscriber` (604-657 行) でも実装されており、Map 削除契機の close 責務が `App.tsx` 側にしかない点で「呼び出し元が知らないと壊れる」状態になっている
- 「Map から外す責任」は `signals/subscriber.ts:subscriberInstances` を所有する `signals/subscriber.ts` にあるが、Map 削除契機の close 責務だけが呼び出し元にあるのは責務境界として不自然。0162 では「Map から外す = リソース解放契機」を `signals/subscriber.ts` に集約する
- Remove ボタンは `SubscriberPanel.tsx` で `disabled={isSubscribing}` ガードされているが、`stopSubscribing` の `await unsubscribe()` 中に Remove 押下が反映されるレースは現状の 0144 実装でも存在する。0162 は所有者側に close を集約することでガード位置依存の挙動を解消する

## 設計上のトレードオフ

`signals/subscriber.ts` は本来「Signal を保持する素の状態管理層」で、`DecoderWrapper.close()` / `Session.close()` の呼び出しは `useSubscriber.ts` (リソースを生成する層) の責務に近い。ただし `App.tsx` から `useSubscriber` フックの戻り値にはアクセスできない (closed/#0144 で検討済み) ため、Map 削除契機の close 呼び出しを `App.tsx` ではなく `signals/subscriber.ts` に集約するのが現実的な妥協点となる。`signals/subscriber.ts` が `DecoderWrapper` / `Session` の `close()` 契約に依存することを許容する代わりに、呼び出し元の知識重複を解消する。

## 関連 issue との順序

- 0162 → 0171 の順で実装する (0171 の完了条件にも「issue #0162 が先に完了している (依存関係)」と明記済み)
- 0162 完了後も `useSubscriber.ts` 側 (0171 適用後は `closeSubscriberResources`) には close 呼び出しが残る。0171 は明示的に「`useSubscriber.ts` 内に close 系の責務を残す」方針 (`useSubscriber.ts:cleanupSubscriber` 経由の経路では `instance` がまだ Map 上に存在し `removeSubscriber` が呼ばれないため)。0162 は「Map 削除契機の close」、0171 の `closeSubscriberResources` は「cleanup コールバック契機の close」で発火経路が異なる分担であり、二重定義ではない
- 0163 (`statusMessage` レース) は本 issue と直交

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
  const instance = getSubscriber(id);
  if (instance) {
    // decoder → session の順で fire-and-forget close する。
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

- close の順序は `useSubscriber.ts:cleanupSubscriber` と揃え、decoder → session とする
- close は fire-and-forget。close 完了を待たずに Map から削除する
- 既存のエクスポート `getSubscriber(id)` を使い、直 `.value.get(id)` は使わない (同モジュール内ヘルパで揃える)
- `decoder.value` / `session.value` を null へリセットしない。`removeSubscriber` 通過後は `getSubscriber` が undefined を返すため、後続の `cleanupSubscriber` 経路は signal 操作に到達せず no-op になる
- `session.value = null` を `session.close()` より先に立てる対策は本関数では入れない。`Session.close` 自体が冪等であり、再入経路の二重 close は close 関数側で吸収される (後述「二重 close についての整理」参照)

### 2. `App.tsx:handleRemoveSubscriber` ラッパーを廃止する

`handleRemoveSubscriber` 関数自体を削除し、呼び出し箇所 (`App.tsx:146`) を `onRemove={() => sub.removeSubscriber(id)}` に置き換える。1 行 wrapper を残しても意味的等価で、責務集約の主旨と合わない。

### 3. `useSubscriber.ts` 側は本 issue では変更しない

`cleanupSubscriber` のリネーム・分割は 0171 のスコープ。本 issue では触らない。

## 二重 close についての整理

`removeSubscriber` に close を移しても、close コールバック経由の `cleanupSubscriber` 再入 / Remove 押下後の `useEffect` cleanup などで `decoder.close` / `session.close` が複数回呼ばれる経路は残る。いずれも close 関数側の冪等性で実害なし。

- `Session.close` (`src/session.ts:1988-1991`) は `sessionState === "closed"` で early return するため二重実行は no-op
- `DecoderWrapper.close` (`devtools/src/utils/DecoderWrapper.ts:179-192`) は `state !== "closed"` ガード + Worker 側 `terminate` の冪等性で二重実行は no-op
- `removeSubscriber` 内では `session.value = null` を `session.close()` より先に立てる対策は入れない。0150 の先行 null 化対策は `cleanupSubscriber` 内の再入 (cleanupSubscriber → close コールバック → cleanupSubscriber 再入) を防ぐ目的で入っており、`removeSubscriber` 側の close コールバック発火による `cleanupSubscriber` 再入は close 関数自体の冪等性で吸収する

## 影響範囲

- `devtools/src/signals/subscriber.ts:removeSubscriber` の実装変更
- `devtools/src/App.tsx:handleRemoveSubscriber` の簡素化
- `devtools/src/signals/subscriber.test.ts` のテスト追加 (テスト戦略参照)

`useSubscriber.ts:cleanupSubscriber` 本体は本 issue では変更しない (0171 のスコープ)。

## テスト戦略

Vitest の Chai API (`test` / `assert`) のみ使用。CLAUDE.md「モック / スタブを利用しないこと」を厳格に解釈し、`DecoderWrapper` / `Session` の挙動を差し替えるテスト用オブジェクト注入は行わない。close 呼び出しの観測は手動確認に委ねる。

`signals/subscriber.test.ts` に以下を追加する。

- `removeSubscriber` は `decoder.value` / `session.value` が null のときに例外を投げず Map から削除する
- `removeSubscriber` は instance が存在しない `id` でも例外を投げず Map サイズを維持する

これらは既存テストの拡張で、新規 close 分岐が null チェック (`?.`) を正しく通過することを担保する最小限の検証。close 呼び出し自体の正当性は手動確認で担保する。

手動確認:

- Subscribe 開始 → 接続成立 → Remove ボタン押下 → Chrome DevTools の Network タブで WebTransport 接続が `CLOSED` 状態になることを確認
- Subscribe 開始 → Stop → Remove の順序でも `CLOSED` 状態になることを確認
- `vp run test` で全テストパス
- `vp run build:devtools` でビルド成功

## CHANGES.md 記載方針

`## develop` 直下 `### misc` サブセクションに `[UPDATE]` で記載する。CHANGES.md 冒頭の規約で `[CHANGE]` は「下位互換のない変更」と定義されており、本 issue は devtools 内部関数 (`removeSubscriber`) のシグネチャを変えず挙動を拡張するのみで、moqt-js の公開 API には影響しない。closed #0144 が `[FIX]` で記載されている流れに沿うと `[FIX]` も選択肢になるが、0144 でリーク自体は解消済みであり、本 issue は責務再編であるため `[UPDATE]` が妥当。

エントリ例:

```
- [UPDATE] devtools の `removeSubscriber` に decoder / session の fire-and-forget close を集約する (#0162)
  - @voluntas
```

## ブランチ命名

`feature/change-` を使う (devtools 内部関数の挙動拡張のため)。

## 完了条件

- `signals/subscriber.ts:removeSubscriber` 内で `decoder.value?.close()` と `session.value?.close()` が fire-and-forget で実行される
- `App.tsx:handleRemoveSubscriber` ラッパーが削除され、`onRemove` ハンドラが `() => sub.removeSubscriber(id)` に置き換わる
- `signals/subscriber.test.ts` に上記テスト 2 件が追加され、パスする
- 本 issue は 0171 より先に実装する (0171 の依存関係)
- `vp run test` で全テストパス
- `vp run build:devtools` でビルド成功
- 手動確認 (Remove → WebTransport が CLOSED) で close 呼び出しが正しく走ることを確認する
