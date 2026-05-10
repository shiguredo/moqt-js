# `DebugPanel` の `useEffect` 内 `effect()` を `useSignalEffect` に統一する

Created: 2026-05-10
Model: Opus 4.7

## 概要

`devtools/src/components/DebugPanel.tsx` のオートスクロール処理で `useEffect` 内に `effect()` を起動している:

```ts
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
- 同コンポーネント内に類似の `useEffect` (ESC キー処理) もあるが、これは `document.addEventListener` で signal とは無関係なので対象外。
- コードベース全体で signal を使うパターンを `useSignalEffect` に揃えることで、他の改善 issue (PublisherPanel の useEffect → useSignalEffect 化) と一貫させる。

## 修正方針

1. `useEffect` + `effect` の二重起動を `useSignalEffect` 1 つに置き換える:
   ```ts
   useSignalEffect(() => {
     const logsLength = logs.value.length;
     if (logsLength > 0 && autoScroll.value && logContainerRef.current) {
       logContainerRef.current.scrollTop = 0;
     }
   });
   ```
2. `effect` の import が不要になれば削除する。

## 影響範囲

- `devtools/src/components/DebugPanel.tsx` のみ
