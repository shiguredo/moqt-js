# `DebugPanel` の `useEffect` 内 `effect()` を `useSignalEffect` に統一する

Created: 2026-05-10
Completed: 2026-05-10
Model: Opus 4.7

## 概要

`devtools/src/components/DebugPanel.tsx` の 489-497 行目でオートスクロール処理に `useEffect` 内の `effect()` を使用している:

```typescript
useEffect(() => {
  const cleanup = effect(() => {
    const logsLength = logs.value.length;
    if (logsLength > 0 && autoScroll.value && logContainerRef.current) {
      logContainerRef.current.scrollTop = 0;
    }
  });
  return cleanup;
}, []);
```

これは `useSignalEffect` の自前再実装であり、Preact + signals の標準パターンに揃えるべき。

## 根拠

- `useSignalEffect(() => { ... })` 1 行で同等の挙動が得られ、cleanup の手動配線も不要。
- 同コンポーネント内の ESC キー処理 (499-508 行目) は `document.addEventListener` で signal とは無関係なので対象外。
- コードベース全体で signal を使うパターンを `useSignalEffect` に揃えることで、他の改善 issue (PublisherPanel の useEffect → useSignalEffect 化) と一貫させる。

## 修正方針

1. `import { signal, effect } from "@preact/signals"` を `import { signal, useSignalEffect } from "@preact/signals"` に変更する (`signal` は 18-20 行目で使用しているため残す)。
2. `import { useEffect, useRef, useState, useCallback } from "preact/hooks"` は変更しない (ESC キー処理で `useEffect` が残るため)。
3. 489-497 行目の `useEffect` + `effect` を `useSignalEffect` 1 つに置き換える:
   ```typescript
   useSignalEffect(() => {
     const logsLength = logs.value.length;
     if (logsLength > 0 && autoScroll.value && logContainerRef.current) {
       logContainerRef.current.scrollTop = 0;
     }
   });
   ```

## 影響範囲

- `devtools/src/components/DebugPanel.tsx` のみ

## テスト戦略

- `vp run build` でビルドが通ることを確認する
- ブラウザで devtools を開き、ログが追加されたときにオートスクロールが動作することを手動確認する

## CHANGES.md 記載方針

- `### misc` サブセクションに `[CHANGE]` で記載する (他 issue 群とまとめて 1 エントリにまとめる)。

## 完了条件

- `useEffect` + `effect` が `useSignalEffect` に置き換わっている
- `effect` の import が `useSignalEffect` に変更されている
- ESC キー処理の `useEffect` はそのまま残っている
- `vp run build` が成功する

## 解決方法

- `DebugPanel.tsx` の `@preact/signals` import から `effect` を外し `useSignalEffect` を追加した (`signal` は引き続き利用)
- `useEffect` + `effect` を `useSignalEffect` 1 つに置き換えた (cleanup の手動配線が不要に)
- ESC キー処理の `useEffect` はそのまま残した
- `vp run build:devtools` が通ることを確認した
