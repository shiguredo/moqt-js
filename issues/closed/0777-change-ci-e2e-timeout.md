# CI の e2e ジョブのタイムアウトを 15 分にする

- Created: 2026-09-29
- Completed: 2026-09-29
- Branch: feature/change-ci-e2e-timeout
- Polished: {YYYY-MM-DD}

## 目的

`.github/workflows/ci.yml` の e2e ジョブは `timeout-minutes: 10` で、CI の遅い runner ではテストが 10 分を超えてジョブごとキャンセルされる。実際に PR #412 (issue 0776 の作業) の 1 回目の e2e は 10m33s でキャンセルされ、再実行では 6m20s で成功した。テストの内容とは無関係に失敗するため、余裕を持たせる。

## 現状

- `.github/workflows/ci.yml` の e2e ジョブは `timeout-minutes: 10`
- CI の runner では 1 テストあたり 5〜13 秒かかり、66 テストで通常 5〜6 分、遅い runner では 10 分を超える
- `playwright.config.ts` の `workers` は 1 で、安定性のためと思われる (これ自体は変更しない)

## 設計方針

- e2e ジョブの `timeout-minutes` を 15 にする。テストの内容と並列度は変えない
- 他のジョブのタイムアウトは変更しない

## 完了条件

- e2e ジョブの `timeout-minutes` が 15 になっている
- CI が通る

## 解決方法

- `.github/workflows/ci.yml` の e2e ジョブの `timeout-minutes` を 10 から 15 に変更した
- テストの内容と並列度 (`playwright.config.ts` の `workers: 1` / `fullyParallel: false`) は変更していない
- PR #412 の 1 回目の e2e が 10m33s でキャンセルされ、再実行が 6m20s で成功したことを根拠にした

## 参照

- `.github/workflows/ci.yml` の e2e ジョブ
- `playwright.config.ts` の `workers` / `fullyParallel`
