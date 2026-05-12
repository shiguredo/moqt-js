# `joiningFetch.onError` で decoder の生存確認を追加する

Created: 2026-05-10
Completed: 2026-05-11
Model: Opus 4.7

## 概要

`useSubscriber.ts:521-532` の `joiningFetch.onError` 内で `decoderInstance.resetKeyframeWait()` を呼んでいるが、この時点で別経路（セッションの `close` コールバック → `cleanupSubscriber` → `decoderInstance.close()`）が既に実行済みの可能性がある。既に close された `DecoderWrapper` に対する `resetKeyframeWait()` の動作は保証されず、内部で意図しない副作用が生じうる。

## 根拠

- `useSubscriber.ts:521-532`: `joiningFetch.onError` は `close` コールバックや `error` コールバックと同時期に発火しうる
- `cleanupSubscriber` (`useSubscriber.ts:619-626`) が先に `decoderInstance.close()` を実行済みの場合、`resetKeyframeWait()` の動作は保証されない
- `joiningFetch.onError` の `decoderInstance` は `instance.decoder.value` から取得しているが、`cleanupSubscriber` が `instance.decoder.value = null` を設定済みの場合は null であり、安全に早期 return する。ただし `decoder.value` が null 以外の状態で `decoder.state !== "configured"` の場合（close 直後など）に問題が生じる

## 修正方針

1. `useSubscriber.ts:521-532` の `if (decoderInstance)` ブロック内で、`resetKeyframeWait()` の呼び出し前に `decoderInstance.state !== "closed"` のガードを追加する

```typescript
const decoderInstance = instance.decoder.value;
if (decoderInstance) {
  if (decoderInstance.state !== "closed") {
    decoderInstance.resetKeyframeWait();
  }
}
```

## 影響範囲

- `devtools/src/hooks/useSubscriber.ts`

## テスト戦略

- `vp run build:devtools` でビルドが通ることを確認する
- `vp run test` で既存の全テストがパスすることを確認する

## CHANGES.md 記載方針

- `### misc` サブセクションに `[FIX]` で記載する

## 完了条件

- `joiningFetch.onError` で `decoderInstance.state !== "closed"` のガードが追加されている
- `vp run build:devtools` が成功する
- `vp run test` が全テストパスする

## 解決方法

- `devtools/src/hooks/useSubscriber.ts` の `joiningFetch.onError` で `if (decoderInstance && decoderInstance.state !== "closed")` のガードを追加し、close 済みの decoder に対する `resetKeyframeWait()` 呼び出しを回避するようにした。
- `CHANGES.md` の `### misc` セクションに `[FIX]` エントリを追加した。
