# `removeSubscriber` 時のリソースリークを修正する

Created: 2026-05-10
Completed: 2026-05-11
Model: Opus 4.7

## 概要

`App.tsx` の `handleRemoveSubscriber` (`App.tsx:15-17`) は `sub.removeSubscriber(id)` のみを呼び出し、WebTransport セッションのクローズ・VideoDecoder のクローズ・DedicatedWorker の停止を一切行っていない。その結果、SubscriberPanel がアンマウントされてもセッション・ストリーム・デコーダが生き残りリソースリークが発生する。

なお Remove ボタンは `SubscriberPanel.tsx:104` で `disabled={isSubscribing}` とガードされており、購読中は押せない。しかし購読が終了して `instance.subscriber.value` が null になった後も `instance.session.value` や `instance.decoder.value` が non-null の状態が継続する場合があり、その間に Remove されるとリークが発生する。

## 根拠

- `App.tsx:15-17` の `handleRemoveSubscriber` は `sub.removeSubscriber(id)` のみを呼ぶ
- `SubscriberPanel.tsx:51` の `isSubscribing` ガードにより購読中は Remove 不可だが、購読終了後も session / decoder が生存している間に Remove が可能
- `cleanupSubscriber` (`useSubscriber.ts:615-662`) は定義されているが、呼び出し元は `startSubscribing` の catch ブロック・`stopSubscribing`・セッションの close/error コールバック・subscribe の end コールバックに限られる
- `handleRemoveSubscriber` からは `useSubscriber` フックの戻り値にアクセスできないため `stopSubscribing` を直接呼べない

## 修正方針

### 1. `handleRemoveSubscriber` で signals 層経由の直接クリーンアップ

`App.tsx:15-17` の `handleRemoveSubscriber` を以下のように変更する:

```typescript
function handleRemoveSubscriber(id: string): void {
  const instance = sub.getSubscriber(id);
  if (instance) {
    try {
      instance.decoder.value?.close();
    } catch {
      /* ignore */
    }
    instance.session.value?.close()?.catch(() => {
      /* 既にクローズされている場合は無視 */
    });
  }
  sub.removeSubscriber(id);
}
```

- `handleRemoveSubscriber` は `App.tsx` のモジュールスコープにあり、`sub.getSubscriber` と signals だけに依存するため実現可能
- `decoder.close()` と `session.close()` は fire-and-forget で呼び出し、非同期完了を待たない
- その後 `sub.removeSubscriber(id)` で Map から削除する

### 2. `useSubscriber` に `useEffect` cleanup を追加（補助的安全策）

`useSubscriber` フック内に以下を追加する:

```typescript
import { useRef, useEffect } from "preact/hooks";
```

```typescript
// コンポーネントアンマウント時の安全策: handleRemoveSubscriber が
// removeSubscriber を先に呼ぶため通常は instance が undefined になり
// no-op だが、将来の予期しないアンマウント経路に備える
useEffect(() => {
  return () => {
    cleanupSubscriber();
  };
}, []);
```

- deps は空配列 `[]` とする（`subscriberId` は key で管理され同一コンポーネント内で変化しないため）
- `removeSubscriber` が先に呼ばれた場合 `getSubscriber` が undefined を返して早期 return するため、`useEffect` cleanup が動作するのはあくまで補助的な経路

### 3. signals/subscriber.ts の `removeSubscriber` は変更不要

`removeSubscriber` は状態管理（Map からの削除）に徹し、リソースクリーンアップは呼び出し側で行う責務分離を維持する。

## 影響範囲

- `devtools/src/App.tsx`: `handleRemoveSubscriber` の修正、`import * as sub` は既存
- `devtools/src/hooks/useSubscriber.ts`: `useEffect` の import 追加と cleanup 追加

## テスト戦略

- `vp run build:devtools` でビルドが通ることを確認する
- `vp run test` で既存の全テストがパスすることを確認する
- ブラウザで以下の手動確認を行う:
  1. Subscriber を接続 → Stop ボタンで停止 → Remove ボタンで削除 → DevTools の Network タブで WebTransport 接続が閉じられていること
  2. Subscriber を 2 つ追加 → 両方接続 → 片方だけ停止 → Remove → 残りの Subscriber が正常に動作すること

## CHANGES.md 記載方針

- 本修正は devtools のバグ修正であるため `## develop` 直下に `[FIX]` として記載する

## 完了条件

- `handleRemoveSubscriber` で `sub.removeSubscriber(id)` の前に decoder と session のクローズが行われる
- `useSubscriber` に `useEffect` cleanup が追加されている
- `vp run build:devtools` が成功する
- `vp run test` が全テストパスする

## 解決方法

- `devtools/src/App.tsx` の `handleRemoveSubscriber` を変更し、`sub.removeSubscriber(id)` の前に `instance.decoder.value?.close()` と `instance.session.value?.close()` を fire-and-forget で呼ぶようにした。`decoder.close()` は同期例外を握りつぶし、`session.close()` の Promise は `.catch(() => {})` で無視する。
- `devtools/src/hooks/useSubscriber.ts` に `useEffect` を追加し、コンポーネントアンマウント時に `cleanupSubscriber()` を呼ぶ補助的な安全策を仕込んだ。
- `CHANGES.md` の `## develop` セクションに `[FIX]` エントリを追加した。
