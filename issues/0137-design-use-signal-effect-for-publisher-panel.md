# `PublisherPanel` の `useEffect` deps を `useSignalEffect` に変更する

Created: 2026-05-10
Model: Opus 4.7

## 概要

`devtools/src/components/PublisherPanel.tsx` で `useEffect(..., [pub.mediaStream.value])` のように `useEffect` の依存配列に signal の `.value` を直接渡している。これは React 流の発想で、@preact/signals の利点を打ち消している。

## 根拠

- @preact/signals では関数コンポーネント本体で `.value` を読んだ瞬間に追跡が成立し、変更で再描画される。`useEffect(deps)` に `.value` を渡すスタイルは冗長で、`MediaStream` のオブジェクト同一性比較になっているのも分かりにくい。
- `useSignalEffect` を使えば signal の変更に正確に追従でき、deps を書く必要がない。

## 修正方針

1. `import { useSignalEffect } from "@preact/signals"` を追加する。
2. 該当 `useEffect` を `useSignalEffect` に置き換え、deps 配列を削除する:
   ```ts
   useSignalEffect(() => {
     if (videoRef.current && pub.mediaStream.value) {
       videoRef.current.srcObject = pub.mediaStream.value;
     } else if (videoRef.current) {
       videoRef.current.srcObject = null;
     }
   });
   ```
3. 他の Panel (`SubscriberPanel` 等) でも同様のパターンがあれば併せて統一する。

## 影響範囲

- `devtools/src/components/PublisherPanel.tsx`
- `devtools/src/components/SubscriberPanel.tsx` (canvas 初期化など、signal 依存の useEffect があれば)
