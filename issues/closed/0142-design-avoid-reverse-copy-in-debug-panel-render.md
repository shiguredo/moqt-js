# `DebugPanel` の `[...logs.value].reverse()` による全コピーを排除する

Created: 2026-05-10
Completed: 2026-05-10
Model: Opus 4.7

## 概要

`devtools/src/components/DebugPanel.tsx` の 661 行目でログ一覧描画に `[...logs.value].reverse().map(...)` を行っており、毎レンダリングで配列を full copy + reverse している。

## 根拠

- `maxLogs` の上限が 1000 件なのでフレームレートが致命的に落ちることはないが、不要な O(n) コピーが頻発する。
- 逆順ループで参照すれば追加割り当てなしで同等の表示が可能。

## 修正方針

逆方向ループ案を採用する:

```tsx
{
  (() => {
    const elements = [];
    for (let i = logs.value.length - 1; i >= 0; i--) {
      const log = logs.value[i];
      const nextLog = i < logs.value.length - 1 ? logs.value[i + 1] : null;
      const previousTimestamp = nextLog ? nextLog.timestamp : null;
      const isExpanded = expandedRows.has(i);
      elements.push(<div key={i} /* ... */>{/* i をそのまま originalIndex として使用 */}</div>);
    }
    return elements;
  })();
}
```

- 配列のコピー・反転が不要になる。
- `originalIndex` の逆算が不要になる (i をそのまま originalIndex として使用)。
- `expandedRows` や `viewModes` の状態管理への影響がない (originalIndex は変わらない)。

## 注意事項

- `expandedRows` (413 行目)、`viewModes` (414 行目)、`key={originalIndex}` は `originalIndex` をキーとしており、`addLog` の `slice` によりインデックスがずれる既存の設計問題があるが、本 issue では対象外 (別 issue で対応する)。
- `generateLogsText` (344 行目) は元順のまま出力する。表示とコピーで順序が異なるが、コピー用テキストは時系列順が自然であるため変更不要。

## 依存関係

- 0134 (SubscriberInstance の signal 化) が先に実装されている場合、`generateSubscriberStatsText` (283-341 行目) 内の `instance.objectsReceived` 等が `.value` 経由に変更されるため、本 issue の変更範囲に含まれる。

## 影響範囲

- `devtools/src/components/DebugPanel.tsx` のみ

## テスト戦略

- `vp run build` でビルドが通ることを確認する
- ブラウザで devtools を開き、ログが逆順 (最新が上) に表示されることを手動確認する

## CHANGES.md 記載方針

- `### misc` サブセクションに `[CHANGE]` で記載する (他 issue 群とまとめて 1 エントリにまとめる)。

## 完了条件

- `[...logs.value].reverse()` が除去されている
- 逆方向ループで同等の表示が得られている
- `vp run build` が成功する

## 解決方法

- `DebugPanel.tsx` のログ描画を `[...logs.value].reverse().map(...)` から逆方向 `for` ループ + `elements.push(...)` に置き換えた
- `originalIndex` は `i` をそのまま使うようにし、`expandedRows` / `viewModes` / `key` のインデックスは従来と同じ意味を保った
- `vp run build:devtools` が通ることを確認した
