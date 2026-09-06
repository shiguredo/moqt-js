# message 層 4 モジュールに異常系テストがない

- Created: 2026-09-06
- Completed: YYYY-MM-DD
- Branch: feature/add-message-error-tests
- Polished: YYYY-MM-DD

## 目的

PBT は正常系 round-trip のみを検証し、意図的なエラーパス・境界値の検証がない。PBT で実現できないケースは単体テストで書く規約に従う必要がある。

## 現状

- `src/message/subscribe.ts` / `publish.ts` / `trackstatus.ts` / `namespace.ts` に対応する `*.test.ts` がなく、`trailing data` / 上限超過 / フィールド数違反等の `PROTOCOL_VIOLATION` 分岐が未検証である。
- `fetch` / `setup` / `parameter` / `session` は `*.test.ts` を持つため不整合である。

## 設計方針

1. 4 モジュールに `*.test.ts` を追加し、異常系・境界値を検証する。
2. PBT と役割分担し、重複は避ける。

## 完了条件

- 4 モジュールの異常系がテストで pin されること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。
