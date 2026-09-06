# 公開 API 境界を整理する

- Created: 2026-09-06
- Completed: YYYY-MM-DD
- Branch: feature/change-public-api-boundary
- Polished: YYYY-MM-DD

## 目的

内部・relay 専用・PBT 専用まで公開面に残り、誤用の余地がある。循環もバンドラ依存で解消している。境界を整理する必要がある。

## 現状

- `src/index.ts` の `export *` (msf) と `export * as` (LOC / MOQLOG / MOQMETRICS) が内部まで全公開する。
- relay 専用・PBT 専用と明記された関数が公開 API 経由で利用可能である。
- `createMedia*` と `index.ts` (`connect`) が循環 import する。
- 内部ヘルパー (`resolveAuthorizationToken` 等) がモジュール公開面に残る。
- `hasContainsEndOfGroup` の冗長命名、`MediaPublisherState` の死に `"ready"`、不要 `async` 6 件が残る。

## 設計方針

1. 公開面を棚卸しし、内部用は非公開化する (テスト経路の確保と両立)。
2. `connect` 分離で循環を解消する。
3. 命名・死に状態・不要 `async` を整理する (破壊的変更は `CODEBASE.md` 方針と相談)。

## 完了条件

- 公開 API が意図した面のみになり、循環が解消されること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 関連

- `0499` / `0501` / `0503` (分割側と連携する)
