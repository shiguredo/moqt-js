# `maxLogs` を signal から定数に変更する

Created: 2026-05-10
Model: Opus 4.7

## 概要

`devtools/src/components/DebugPanel.tsx` で `export const maxLogs = signal(1000);` として定義されているが、UI から変更する経路がなく値は常に 1000 のまま。

## 根拠

- 値が変わらない定数を signal にすると、購読/追跡の機構がノイズになるだけで何のメリットもない。
- 設定として変更できるようにする予定もない (UI に該当する設定項目がない)。

## 修正方針

1. `export const maxLogs = signal(1000);` を `const MAX_LOGS = 1000;` に変更する。
2. `addLog` 内の参照を `maxLogs.value` から `MAX_LOGS` に書き換える。
3. 他から `maxLogs` を import している箇所がないか確認する (現状は同ファイル内のみのはず)。

## 影響範囲

- `devtools/src/components/DebugPanel.tsx` のみ
