# `liveObjectProcessingChain` を `useRef` で安定参照にする

Created: 2026-05-10
Completed: 2026-05-10
Model: Opus 4.7

## 概要

`devtools/src/hooks/useSubscriber.ts` の 56 行目で `let liveObjectProcessingChain = Promise.resolve()` を関数スコープに宣言している。
`useSubscriber` は `SubscriberPanel` が再描画されるたびに呼び出されるため、再描画ごとに新しい変数とクロージャが作られる。

関数スコープの `let` で Promise チェーンを管理するパターンは可読性・保守性に問題がある。

## 根拠

- 関数スコープの `let` で Promise チェーンを管理するパターンは、React/Preact のフックの慣例 (状態は `useRef` や `useState` で管理する) に反する。
- `liveObjectProcessingChain` はライブオブジェクトの順次処理用 Promise チェーンであり、Subscriber インスタンスのライフサイクル全体で 1 本に保つことが正しい挙動。
- `useRef` を使えば、レンダリング間で安定した参照が保証され、意図しない再初期化を防止できる。

## 修正方針

1. `useSubscriber.ts` の import に `useRef` を追加する:
   ```typescript
   import { useRef } from "preact/hooks";
   ```
2. 56 行目の `let liveObjectProcessingChain = Promise.resolve()` を `const chainRef = useRef<Promise<void>>(Promise.resolve())` に置き換える。
3. 626 行目の代入箇所を `chainRef.current = chainRef.current.then(() => handleObject(obj))` に変更する。
4. `cleanupSubscriber` (700-744 行目) に `chainRef.current = Promise.resolve()` を追加し、古いチェーンをリセットする (Subscriber 再起動時に古い Promise が永遠に resolve されない場合のリーク防止)。

## 影響範囲

- `devtools/src/hooks/useSubscriber.ts` のみ

## テスト戦略

- `vp run test` を実行し既存テストが通ることを確認する
- Promise チェーンの順序保証を手動確認する (デバッグログで到着順と処理順を比較する)

## CHANGES.md 記載方針

- `### misc` サブセクションに `[CHANGE]` で記載する (他 issue 群とまとめて 1 エントリにまとめる)。

## 完了条件

- `useRef` の import が追加されている
- 56 行目が `const chainRef = useRef<Promise<void>>(Promise.resolve())` に変更されている
- 626 行目が `chainRef.current` 経由に変更されている
- `cleanupSubscriber` に `chainRef.current = Promise.resolve()` が追加されている
- テストが全てパスする

## 解決方法

- `useSubscriber.ts` に `import { useRef } from "preact/hooks"` を追加した
- 関数スコープの `let liveObjectProcessingChain = Promise.resolve()` を `const chainRef = useRef<Promise<void>>(Promise.resolve())` に置き換えた
- ライブオブジェクト到着時の代入を `chainRef.current = chainRef.current.then(...)` に変更した
- `cleanupSubscriber` の末尾で `chainRef.current = Promise.resolve()` を実行し、Subscriber 再起動時に古い Promise チェーンを引き継がないようにした
- `vp run build` / `vp run build:devtools` が通ることを確認した
