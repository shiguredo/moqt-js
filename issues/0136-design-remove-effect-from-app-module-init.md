# `App.tsx` モジュールトップレベルの `effect()` を初期化処理に置き換える

Created: 2026-05-10
Model: Opus 4.7

## 概要

`devtools/src/App.tsx` のモジュールトップレベルで `effect(() => { if (sub.subscriberIds.value.length === 0) sub.addSubscriber(); })` を実行している。これは「初回 1 件追加する」初期化を effect で表現したものだが、副作用の意味として不適切。

## 根拠

- `effect` は依存 signal の変更に追従して再実行される仕組みであり、「初期化の 1 回だけ」を表現する用途ではない。
- 現状は `length === 0` ガードで無限ループを避けているだけで、リアクティブ性は何も活用していない。
- モジュール load 時にグローバル副作用が走るのも避けたい (テスト/HMR で扱いづらい)。

## 修正方針

1. `App.tsx` の `effect(...)` ブロックを削除する。
2. `devtools/src/main.tsx` の初期化フローに以下を追加する:
   ```ts
   import * as sub from "./signals/subscriber";
   if (sub.subscriberIds.value.length === 0) {
     sub.addSubscriber();
   }
   ```
3. `App.tsx` から `effect` import を削除する。

## 影響範囲

- `devtools/src/App.tsx`
- `devtools/src/main.tsx`
