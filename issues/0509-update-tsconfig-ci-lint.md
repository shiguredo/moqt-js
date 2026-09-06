# tsconfig・lint・CI の規約整合を修正する

- Created: 2026-09-06
- Completed: YYYY-MM-DD
- Branch: feature/update-tsconfig-ci-lint
- Polished: YYYY-MM-DD

## 目的

型検査と品質ゲートが規約・出荷標準とずれ、問題の集中域が自動検査外になる。設定を整合させる必要がある。

## 現状

- `tsconfig.json` に `noUncheckedIndexedAccess` / `exactOptionalPropertyTypes` がなく、`esModuleInterop: true` 明示と `skipLibCheck: true` が規約に反する。`types: []` の明示もない。
- `vite.config.ts` の `lint.ignorePatterns` が devtools / examples / tests を除外し、type-aware lint が src のみに効く。`reportUnusedDisableDirectives` がない。
- CI の typecheck 行列が 5.7〜6.0 + next で、出荷標準 7.0.2 を検証しない。`lint` が `vp lint` のみで fmt 破壊を検出できず、`paths-ignore: **.md` で docs 乖離が素通しになる。

## 設計方針

1. tsconfig を規約の必須チェックに合わせる。
2. lint 対象と CI 行列・ゲートを出荷標準に合わせる (devtools / examples の扱いを決める)。

## 完了条件

- 設定が規約と一致し、CI で出荷標準が検証されること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。
