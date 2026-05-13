# `maxLogs` を signal から定数に変更する

Created: 2026-05-10
Completed: 2026-05-10
Model: Opus 4.7

## 概要

`devtools/src/components/DebugPanel.tsx` の 19 行目で `export const maxLogs = signal(1000);` として定義されているが、UI から変更する経路がなく値は常に 1000 のまま。

## 根拠

- 値が変わらない定数を signal にすると、購読/追跡の機構がノイズになるだけで何のメリットもない。
- 設定として変更できるようにする予定もない (UI に該当する設定項目がない)。

## 確認済み事項

- `maxLogs` を他ファイルから import している箇所は存在しない。

## 修正方針

1. 19 行目の `export const maxLogs = signal(1000);` を `const MAX_LOGS = 1000;` に変更する (`export` を外す)。
2. 184 行目の `addLog` 内の参照を `maxLogs.value` から `MAX_LOGS` に書き換える。

## 影響範囲

- `devtools/src/components/DebugPanel.tsx` のみ

## テスト戦略

- `vp run build` でビルドが通ることを確認する
- 既存テスト (`vp test`) が全て通ることを確認する

## CHANGES.md 記載方針

- `### misc` サブセクションに `[CHANGE]` で記載する (他 issue 群とまとめて 1 エントリにまとめる)。

## 完了条件

- `maxLogs` の signal 定義が定数に変更されている
- `export` が削除されている
- `vp run build` が成功する

## 解決方法

- `DebugPanel.tsx` の `export const maxLogs = signal(1000)` を `const MAX_LOGS = 1000` に変更し export を外した
- `addLog` 内の参照を `maxLogs.value` から `MAX_LOGS` に書き換えた
- `vp run build:devtools` / `vp test` (456 passed) が通ることを確認した
