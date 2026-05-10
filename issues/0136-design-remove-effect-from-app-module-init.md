# `App.tsx` モジュールトップレベルの `effect()` を初期化処理に置き換える

Created: 2026-05-10
Model: Opus 4.7

## 概要

`devtools/src/App.tsx` の 13-18 行目でモジュールトップレベルの `effect()` を実行している:

```typescript
effect(() => {
  if (sub.subscriberIds.value.length === 0) {
    sub.addSubscriber();
  }
});
```

これは「初回 1 件追加する」初期化を effect で表現したものだが、副作用の意味として不適切。

## 根拠

- `effect` は依存 signal の変更に追従して再実行される仕組みであり、「初期化の 1 回だけ」を表現する用途ではない。
- 現状は `length === 0` ガードで無限ループを避けているだけで、リアクティブ性は何も活用していない。
- モジュール load 時にグローバル副作用が走るのも避けたい (テスト/HMR で扱いづらい)。

## 修正方針

1. `App.tsx` の 13-18 行目の `effect(...)` ブロックを削除する。
2. `App.tsx` の 1 行目 `import { signal, effect } from "@preact/signals"` から `effect` を削除し `import { signal } from "@preact/signals"` に変更する (`signal` は `copyButtonText` で使用しているため残す)。
3. `devtools/src/main.tsx` の `initTestApi()` の後、`render()` の前に以下を追加する:
   ```typescript
   import * as sub from "./signals/subscriber";

   // 初期化: 最初の Subscriber を作成
   if (sub.subscriberIds.value.length === 0) {
     sub.addSubscriber();
   }
   ```
4. `App.tsx` の `import * as sub from "./signals/subscriber"` は残す (他の箇所で使用しているため)。

## 影響範囲

- `devtools/src/App.tsx`: effect ブロック削除、import 修正
- `devtools/src/main.tsx`: 初期化コード追加

## テスト戦略

- `vp run build` でビルドが通ることを確認する
- ブラウザで devtools を開き、初回 Subscriber が自動的に追加されることを手動確認する

## CHANGES.md 記載方針

- `### misc` サブセクションに `[CHANGE]` で記載する (他 issue 群とまとめて 1 エントリにまとめる)。

## 完了条件

- `App.tsx` の `effect(...)` ブロックが削除されている
- `App.tsx` の import から `effect` が削除されている
- `main.tsx` に初期化コードが追加されている
- `vp run build` が成功する
