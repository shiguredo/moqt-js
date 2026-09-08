# 非先頭の DATAGRAM + SUBGROUP_PRESENT オブジェクトのデコードをテストする

- Created: 2026-09-08
- Completed: YYYY-MM-DD
- Branch: feature/add-fetch-datagram-nonfirst-test
- Polished: YYYY-MM-DD

## 目的

DATAGRAM ビットが立つオブジェクトは先頭・非先頭を問わず Subgroup ID フィールドを持たない。`decodeFetchSubgroupId` は `isDatagram` 判定後に早期 return するため構造上カバーされているが、非先頭（context あり）の明示テストが無く、将来の退行検知が遅れる。

## 現状

- `src/dataStream.fetch.test.ts` の DATAGRAM + SUBGROUP_PRESENT テストは先頭オブジェクト（isFirst=true、context=null）のみを検証する。
- 非先頭の混合テストは DATAGRAM に SUBGROUP_PRESENT を含まない。
- `src/dataStream.ts` の `decodeFetchObjectFields` は DATAGRAM 時に `newContext.subgroupId` へ直前の実 Subgroup ID を保持するが、これを非先頭ケースで固定していない。

## 設計方針

1. 先頭で DATAGRAM オブジェクトをデコードして context を得る。
2. 非先頭で DATAGRAM + SUBGROUP_PRESENT のオブジェクトをデコードし、Subgroup ID を消費せず Object ID / Priority / payload length が復元されることを検証する。
3. `newContext.subgroupId` が直前の実 Subgroup ID を保持することも検証する。

## 完了条件

- 非先頭 DATAGRAM + SUBGROUP_PRESENT のデコードテストが通ること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 関連

- draft-ietf-moq-transport-20 §11.4.4 / §11.4.4.1
- `decodeFetchSubgroupId` / `decodeFetchObjectFields`
