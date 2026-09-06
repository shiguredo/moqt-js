# session 系モジュールに Property-Based Testing がない

- Created: 2026-09-06
- Completed: YYYY-MM-DD
- Branch: feature/add-session-pbt
- Polished: YYYY-MM-DD

## 目的

`src/session/` 配下は例示ベースの単体テストのみで、encode / decode 対称性や連鎖不変条件を横断的に検証できない。PBT で実現できるものは PBT で書く規約に従う必要がある。

## 現状

- `src/session/params.ts` (`mergeRangeFilters` / `build*Parameters` / filter 解決連携)、`stream.ts` (`processFetchObjects` / `processSubgroupObjects`)、`bidi.ts`、`namespaceLoops.ts`、`incoming.ts`、`publish.ts` に対応する `*.prop.ts` がない。
- バッチ内複数オブジェクトの連鎖不変条件 (例: subgroup 先頭判定の退行) は PBT があれば検出可能だった。

## 設計方針

1. 対象モジュールごとに `*.prop.ts` を新設し、round-trip と連鎖不変条件を検証する (既存 `*.prop.ts` の流儀を踏襲)。
2. PBT でカバーできた固定値テストは単体側から削除する。

## 完了条件

- 対象モジュールに `*.prop.ts` が追加され、`vp test run` で実行されること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。
