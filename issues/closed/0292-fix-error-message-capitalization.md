# エラーメッセージの大文字始まりを修正する

- Priority: Low
- Created: 2026-06-03
- Model: deepseek-v4-pro
- Branch: feature/draft-18
- Completed: 2026-06-03

## 目的

AGENTS.md:126「小文字で始めること」に反するエラーメッセージが複数残っている。

## 優先度根拠

プロジェクト規約違反。#0262 で 4 箇所修正されたが、見落としがある。

## 現状

`src/dataStream.ts`:
- Line 425: `"Protocol violation: properties on non-Normal status object"`
- Line 1065: `"Group ID and Object ID required for End of Range"`
- Line 1093: `"Group ID required when GROUP_ID_PRESENT flag is set"`
- Line 1116: `"Subgroup ID required when SUBGROUP_PRESENT is set"`
- Line 1130: `"Object ID required when OBJECT_ID_PRESENT flag is set"`
- Line 1146: `"Publisher Priority required when PRIORITY_PRESENT flag is set"`

## 設計方針

- 全エラーメッセージの先頭を小文字に修正する
- テストも追従修正する

## 完了条件

- 全エラーメッセージが小文字始まりになっている
- 全テストが PASS する

## 解決方法

AGENTS.md から「小文字で始めること」規約が撤廃されたため、本 issue は不要と判断しクローズする。エラーメッセージの先頭ケースはもはや制約がなく、既存の大文字始まりエラーメッセージ（`dataStream.ts` の `"Protocol violation:..."` 等）も修正不要。
