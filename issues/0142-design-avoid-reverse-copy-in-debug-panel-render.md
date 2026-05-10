# `DebugPanel` の `[...logs.value].reverse()` による全コピーを排除する

Created: 2026-05-10
Model: Opus 4.7

## 概要

`devtools/src/components/DebugPanel.tsx` のログ一覧描画で `[...logs.value].reverse().map(...)` を行っており、毎レンダリングで配列を full copy + reverse している。

## 根拠

- `maxLogs` の上限が 1000 件なのでフレームレートが致命的に落ちることはないが、ログが増えるたび全 SubscriberPanel が再描画される現状 (issue 0134 関連) と組み合わさると、不要な O(n) コピーが頻発する。
- 逆順 index で参照すれば追加割り当てなしで同等の表示が可能。

## 修正方針

以下のいずれかを採用する:

1. **逆順 index 案 (推奨)**:
   ```ts
   {logs.value.length === 0 ? (...) : (
     <div class="space-y-1">
       {Array.from({ length: logs.value.length }, (_, reverseIndex) => {
         const originalIndex = logs.value.length - 1 - reverseIndex;
         const log = logs.value[originalIndex];
         ...
       })}
     </div>
   )}
   ```
   現在のロジック (`originalIndex` を逆算する処理) と整合する。

2. **データ構造を逆順保持**: `addLog` で `[entry, ...logs.value].slice(0, maxLogs.value)` のように先頭追加にする。`originalIndex` の意味が変わるので、既存コードへの影響範囲が広い。

1 を選ぶ。

## 影響範囲

- `devtools/src/components/DebugPanel.tsx` のみ
