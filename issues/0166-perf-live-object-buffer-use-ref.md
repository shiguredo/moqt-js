# `liveObjectBuffer` を Signal から `useRef` ベースに置き換える

Created: 2026-05-11
Model: Opus 4.7

## 概要

`useSubscriber.ts` の `object:` コールバックは Joining Fetch 中に以下のコードでオブジェクトをバッファに積む:

```typescript
instance.liveObjectBuffer.value = [...instance.liveObjectBuffer.value, obj];
```

各 push で配列全体をコピーするため O(n²)。Joining Fetch 中に 1000 オブジェクト溜まれば 500,500 要素コピー。`liveObjectBuffer` は UI 描画に使われていないため Signal にする必要がなく、`useRef<MoqtObject[]>([])` に置き換えれば mutable に追記できる。

## 根拠

- `useSubscriber.ts` の `liveObjectBuffer.value = [...instance.liveObjectBuffer.value, obj]` (2 箇所)
- `SubscriberPanel.tsx` / `DebugPanel.tsx` / `testApi.ts` で `liveObjectBuffer` は読まれていない
- ドレインループで `instance.liveObjectBuffer.value = []` でクリアする側も `useRef` 経由で配列を直接空にすればよい

## 修正方針

1. `signals/subscriber.ts:SubscriberInstance` から `liveObjectBuffer: Signal<MoqtObject[]>` を削除
2. `useSubscriber` フック内で `const liveObjectBufferRef = useRef<MoqtObject[]>([])` を保持
3. `object:` コールバック内で `liveObjectBufferRef.current.push(obj)` で mutate
4. ドレインループで `liveObjectBufferRef.current.splice(0)` または再代入でクリア
5. `cleanupSubscriber` 内で `liveObjectBufferRef.current = []` (もしくは `splice(0)`)

なお issue #0164 (Signal 粒度設計再考) を先行させると、本 issue は #0164 の一部として吸収される。順序は実装時に判断する。

## 影響範囲

- `devtools/src/signals/subscriber.ts`
- `devtools/src/hooks/useSubscriber.ts`
- `devtools/src/signals/subscriber.test.ts`

## テスト戦略

- `vp run test` で全テストがパスすること
- 既存の `signals/subscriber.test.ts:createSubscriberInstance initializes signals with expected defaults` から `liveObjectBuffer` 検証を外す
- 手動: Joining Fetch 中に大量オブジェクト到着でも遅延なくドレイン完了することを確認

## CHANGES.md 記載方針

- `### misc` サブセクションに `[UPDATE]` で記載する (性能改善 + 内部表現変更)

## 完了条件

- `liveObjectBuffer` が Signal から `useRef` に置き換わっている
- O(n²) コピーが O(1) push に変わっている
- 全テストパス
