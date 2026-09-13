# @vitest/coverage-v8 を vite-plus 同梱 vitest に合わせてカバレッジ計測を復旧する

- Created: 2026-09-12
- Completed: 2026-09-13
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

## 解決方法

設計方針 1〜3 に従い、`@vitest/coverage-v8` を `vite-plus@0.3.0` が同梱する vitest と同一バージョンに固定した。

- `package.json` の `@vitest/coverage-v8` を `5.0.0` から `4.1.11` に変更した。`node_modules/vite-plus/package.json` の `dependencies.vitest` が `4.1.11` であることを確認している。
- lockfile の更新は `vp install --no-frozen-lockfile` で行った。CI 既定の frozen-lockfile では specifier 不一致で失敗するため明示的に解除した。lockfile 上も `@vitest/coverage-v8@4.1.11` に解決されていることを確認した。
- 固定値の根拠は `CHANGES.md` の `## develop` の `### misc` に記載した («bundled vitest と単一版数を担保するため固定する (vite-plus の更新時は同梱 vitest に追随させる)»)。先行する同種の更新 (vite-plus 0.2.1 / vitest 4.1.9) と同じ書き方に揃えている。

### package.json にコメントを残さなかった理由

設計方針 3 は「固定値の根拠をコメントに残す」としているが、`package.json` は JSON でありコメントを書けない。既存の `package.json` にもコメントは無く、依存のバージョンを上げる際の根拠は `CHANGES.md` に書く運用が先行例 (vite-plus 0.2.1 の更新) で取られているため、それに従った。

## 検証

- `pnpm test:cov` (`vp test --coverage`) が Startup Error なしで完了し、カバレッジサマリが出力されることを確認した。
  - Statements 75.46% (7248/9604) / Branches 69.05% (3686/5338) / Functions 72.96% (915/1254) / Lines 75.67% (7098/9379)
- `pnpm test run`: 70 ファイル / 2,110 テスト全通過
- `pnpm typecheck` / `pnpm lint` / `vp check` すべて成功 (フォーマット 798 ファイル / lint・型チェック 124 ファイル)
- `@vitest/coverage-v8` のバージョンが `4.1.11` で、vite-plus 同梱 vitest と一致していることを lockfile と `node_modules` で確認した。
