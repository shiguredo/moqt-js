# e2e が tsc --noEmit の型検査対象外になっている

- Created: 2026-11-03
- Completed: {YYYY-MM-DD}
- Branch: feature/add-e2e-typecheck
- Polished: {YYYY-MM-DD}

## 目的

`tsconfig.json` の `include` が `src/**/*` のみのため、`tests/e2e/` 配下の spec とハーネスは `tsc --noEmit` の型検査を受けない。`vp check` の type-aware lint で一部は検出されるが、型の取り違えや未定義参照の検出力が弱い。0892 では `page.evaluate` の中に Node 側のヘルパーを書いてしまい、実行時に初めて `ReferenceError` になった (型検査の対象であれば、ブラウザ側で実行されるコールバックのスコープは別問題としても、少なくとも型の不整合は検出できる)。

## 現状

- `tsconfig.json` の `include` は `src/**/*` のみ
- `tests/e2e/` は Playwright の spec と `window.__moqtE2E` の型宣言を持つが、`tsc --noEmit` の対象外
- `vp check` の型チェックは 675 ファイル (src と一部) を対象にしており、e2e は含まれない
- 0892 の 3 周目レビューでも「e2e の型の誤りは oxlint type-aware でしか検出されない」と指摘された

## 設計方針

e2e を型検査の対象に加える。`tsconfig.json` の `include` に `tests/**/*` を足すと、Playwright の型と DOM の型が混ざるため、専用の `tsconfig.e2e.json` を作る案と、既存の `tsconfig.json` に足す案を比較する。

- 専用 tsconfig を作る場合、`vp check` の型チェックに含める方法 (vp の設定) を確認する
- 既存の `tsconfig.json` に足す場合、`lib` / `types` の衝突 (Node の型と DOM の型) を解消する
- 型エラーが大量に出る場合は、修正を別 issue に分けてから対象に加える

## 完了条件

- `tests/e2e/` の型検査が CI (`vp check` または専用コマンド) で走る
- 既存の e2e に型エラーが無い (または型エラーの修正を別 issue に分けた)
- `vp check` と `vp test --run` が通る

`CHANGES.md` は MOQT RFC ドラフト中のため更新しない (`CODEBASE.md` の特別ルール)。テスト基盤のみの変更のため `### misc` にも記載しない。

## 参照

- `tsconfig.json` の `include`
- `tests/e2e/` の spec と `window.__moqtE2E` の型宣言
- `playwright.config.ts`
- `issues/closed/0892-test-relay-discovered-namespace-subscribe.md` の 3 周目レビュー (e2e の型検査範囲)
