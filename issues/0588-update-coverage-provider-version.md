# @vitest/coverage-v8 を vite-plus 同梱 vitest に合わせてカバレッジ計測を復旧する

- Created: 2026-09-12
- Completed: {YYYY-MM-DD}
- Branch: feature/update-coverage-provider-version
- Polished: {YYYY-MM-DD}

## 目的

`test:cov` (`vp test --coverage`) がバージョン不整合で起動しない。カバレッジ計測を実行できる状態に戻す。

## 現状

- `package.json` は `@vitest/coverage-v8` を `5.0.0` に固定している。
- `vite-plus@0.3.0` は `vitest@4.1.11` を同梱しており、`vp test run --coverage` は次の Startup Error で失敗する: "vite-plus bundles vitest@4.1.11, but @vitest/coverage-v8@5.0.0 is installed. ... Pin @vitest/coverage-v8 to 4.1.11 in your dependencies."
- 通常の `vp test run` は影響を受けない。`.github/workflows/ci.yml` はカバレッジを実行していない。

## 設計方針

1. vite-plus が同梱する vitest と `@vitest/coverage-v8` のバージョンを一致させる。エラー文言に従い `@vitest/coverage-v8` を同梱 vitest と同一バージョン (現時点では 4.1.11) に固定することを第一候補とする。
2. 依存の解決は `vp` 経由で行い、lockfile を更新する。
3. バージョン固定の値は vite-plus の更新で変わるため、固定値の根拠 (同梱 vitest に合わせる) をコメントに残す。

## 完了条件

- `vp test run --coverage` が Startup Error なしで完了し、カバレッジが出力されること。
- `@vitest/coverage-v8` のバージョンが vite-plus 同梱 vitest と一致していること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。
- `CHANGES.md` の `## develop` に `[UPDATE]` を追加すること (misc の要否は規約に従い判断する)。

## 参照

- `package.json` (`@vitest/coverage-v8` / `vite-plus` / `test:cov` スクリプト)
- `issues/0509-update-tsconfig-ci-lint.md` (ツールチェーン整合の関連 issue)
