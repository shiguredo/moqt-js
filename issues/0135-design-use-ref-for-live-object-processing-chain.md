# `liveObjectProcessingChain` を `useRef` で安定参照にする

Created: 2026-05-10
Model: Opus 4.7

## 概要

`devtools/src/hooks/useSubscriber.ts` の冒頭で hook の関数スコープに `let liveObjectProcessingChain = Promise.resolve()` を宣言している。
`useSubscriber` は `SubscriberPanel` が再描画されるたびに呼び出されるため、再描画ごとに新しい変数とクロージャが作られる。

現在動いているのは `subscribe()` の `object` コールバックが `startSubscribing` 実行時のクロージャをキャプチャしているからにすぎず、再描画ごとに別 hook 呼び出しの `liveObjectProcessingChain` が並行して存在する状態は壊れやすい。

## 根拠

- 関数スコープの `let` で hook 間状態を持たせるのは React/Preact の不変則 (hook の状態は描画間で安定参照を持つ) に反する。
- `liveObjectProcessingChain` はライブオブジェクトの順次処理用 Promise チェーンであり、Subscriber インスタンスのライフサイクル全体で 1 本に保つことが正しい挙動。
- 再描画契機 (Subscriber 統計の更新など) で関数が呼び直されるたびに古い参照が破棄される設計は、将来別経路から触られた瞬間に順序破綻が顕在化する。

## 修正方針

1. `useSubscriber` の冒頭の `let liveObjectProcessingChain = Promise.resolve()` を `useRef<Promise<void>>(Promise.resolve())` に置き換える。
2. 代入箇所 (`liveObjectProcessingChain = liveObjectProcessingChain.then(...)`) を `chainRef.current = chainRef.current.then(...)` に変更する。
3. `cleanupSubscriber` で必要に応じて `chainRef.current = Promise.resolve()` にリセットする (Subscriber 再起動時に古いチェーンを引きずらない)。

## 影響範囲

- `devtools/src/hooks/useSubscriber.ts` のみ
