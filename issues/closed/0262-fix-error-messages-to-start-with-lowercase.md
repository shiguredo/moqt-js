# エラーメッセージの先頭を小文字に修正する

- Priority: Medium
- Created: 2026-06-03
- Model: deepseek-v4-pro
- Branch: feature/draft-18
- Polished: 2026-06-03
- Completed: 2026-06-03

## 目的

AGENTS.md の「エラーメッセージは全て英語 — 小文字で始めること」に違反する新規エラーメッセージが 4 箇所存在する。これらを修正する。

## 優先度根拠

AGENTS.md の規約違反。規約に沿った一貫性のあるエラーメッセージにすることで、コード品質を維持する。

## 現状

| ファイル              | 行   | 現状                                                                 |
| --------------------- | ---- | -------------------------------------------------------------------- |
| `src/session/bidi.ts` | 815  | `"REQUEST_UPDATE_OK must not contain Track Properties"`              |
| `src/session.ts`      | 1800 | `"SUBSCRIBE_NAMESPACE_OK must not contain Track Properties"`         |
| `src/session.ts`      | 2244 | `"PUBLISH_NAMESPACE_OK must not contain Track Properties"`           |
| `src/properties.ts`   | 671  | `"IMMUTABLE_PROPERTIES cannot contain another IMMUTABLE_PROPERTIES"` |

## 設計方針

プロトコル識別子を文頭ではなく文中に配置し、小文字の一般語から始める。

修正案:

- `"REQUEST_UPDATE_OK must not contain Track Properties"` → `"track properties must be empty in REQUEST_UPDATE_OK"`
- `"SUBSCRIBE_NAMESPACE_OK must not contain Track Properties"` → `"track properties must be empty in SUBSCRIBE_NAMESPACE_OK"`
- `"PUBLISH_NAMESPACE_OK must not contain Track Properties"` → `"track properties must be empty in PUBLISH_NAMESPACE_OK"`
- `"IMMUTABLE_PROPERTIES cannot contain another IMMUTABLE_PROPERTIES"` → `"immutable properties must not recursively contain another immutable properties key"`
- `"received duplicate GOAWAY on request stream"` → 既に小文字始まりのため修正不要

## 完了条件

- 全 4 箇所のエラーメッセージが小文字で始まること
- エラーメッセージが末尾にピリオドを含まないこと
- テストが追従すること

## 解決方法

1. 各ファイルのエラーメッセージ文字列を修正する
2. 対応するテストがあれば追従修正する
