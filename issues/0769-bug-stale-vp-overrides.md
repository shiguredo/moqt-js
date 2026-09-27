# vp up 後に pnpm-workspace.yaml の overrides が古く、CI の build と e2e が失敗する

- Created: 2026-09-27
- Completed: {YYYY-MM-DD}
- Branch: feature/add-devtools-eventtimeline-messages
- Polished: {YYYY-MM-DD}

## 目的

develop の CI が `build` と `e2e` で失敗しており、以降の PR がすべてマージできない。ローカルでも `vp run build` が同じ理由で失敗する。

根拠: develop の CI (run 36285867675、`vp up` の push) が `vp run build` で失敗し、PR #406 の CI (run 36287686145) も同じ失敗をしている。`lint` と `typecheck` は pass する。

## 現状

- `vp up` のコミットで `package.json` の `vite-plus` が 1.0.0-rc.1 になった
- 一方 `pnpm-workspace.yaml` の `overrides` は次のままで、vite-plus が同梱する core の版と一致していない
  - `vite: npm:@voidzero-dev/vite-plus-core@0.3.3`
  - `"@voidzero-dev/vite-plus-core": 0.3.3`
- このため vite-plus 1.0.0-rc.1 が解決する `vite` が 0.3.3 になり、`vp run build` (`vp pack`) が次のエラーで失敗する
  - `Failed to resolve pack command: GenericFailure, Expected @voidzero-dev/vite-plus-core@1.0.0-rc.1, but found @voidzero-dev/vite-plus-core@0.3.3`
- `e2e` ジョブの `vp run e2e-test` は先に `vp run build` を実行するため、同じ理由で失敗する

## 設計方針

- `pnpm-workspace.yaml` の `overrides` の `vite` と `@voidzero-dev/vite-plus-core` を 1.0.0-rc.1 に揃える
- `vp install` で `pnpm-lock.yaml` を再生成し、vite-plus 1.0.0-rc.1 の `vite` が 1.0.0-rc.1 に解決されることを確認する
- `vitest: 4.1.11` の override は据え置く
- 一時 worktree での検証では、overrides を 1.0.0-rc.1 に揃えると `vp run build` が成功し、`vp test run` も通る

## 完了条件

- `vp run build` と `vp run e2e-test` が通る
- develop の CI (`lint` / `build` / `typecheck` / `e2e`) が pass する
