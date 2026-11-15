# e2e が tsc --noEmit の型検査対象外になっている

- Created: 2026-11-03
- Completed: {YYYY-MM-DD}
- Branch: feature/add-e2e-typecheck
- Polished: 2026-11-15
- Refreshed: 2026-11-14

## 目的

`tsconfig.json` の `include` が `src/**/*` のみのため、`tests/e2e/` 配下の spec とハーネスは `tsc --noEmit` の型検査を受けない。`vp check` の type-aware lint で一部は検出されるが、型の取り違えや未定義参照の検出力が弱い。0892 では `page.evaluate` の中に Node 側のヘルパーを書いてしまい、実行時に初めて `ReferenceError` になった (型検査の対象であれば、ブラウザ側で実行されるコールバックのスコープは別問題としても、少なくとも型の不整合は検出できる)。

## 現状

- `tsconfig.json` の `include` は `src/**/*` のみ
- `tests/e2e/` は Playwright の spec と `window.__moqtE2E` の型宣言を持つが、`tsc --noEmit` の対象外
- `vp check` は oxlint の type-aware lint と型検査を `tests/e2e/` の spec にも行う (`dist` が無いと `moqt-js` の型解決に失敗するため、CI の lint ジョブは `vp check` の前に `vp run build` を実行する)。一方、`package.json` の `typecheck` (`tsc --noEmit`) と CI の `typecheck` ジョブは `tsconfig.json` の `include` に従うため e2e を含まない
- `vp check` の型検査は `tests/e2e/` の型エラーをすべては検出しない。`tests/e2e/**/*` を `tsc --noEmit` に含めた実測 (2026-11-15、TypeScript 7.0.2、`src/**/*.d.ts` と `devtools/src/**/*.d.ts` を取り込む専用 tsconfig) では 70 件の型エラーが出る。内訳は TS4111 (`noPropertyAccessFromIndexSignature`) 55 件、TS18048 (possibly undefined) 8 件、TS2345 4 件、TS2532 2 件、TS2379 (`exactOptionalPropertyTypes`) 1 件。同じ状態で `vp check --no-fmt --no-lint` は型エラー 0 件を報告する
- 上記の実測で、`tests/e2e/` は `devtools/src/` と `src/` を直接 import しているため、既存の `tsconfig.json` に `tests/**/*` を足すと devtools のソースが root の型検査に入り、`devtools/tsconfig.json` の `allowImportingTsExtensions` に相当する設定が必要になる
- TypeScript 5.7 で同じ専用 tsconfig を `skipLibCheck: false` のまま実行すると、`lib.dom.d.ts` の `TextDecoder` / `TextEncoder` と `@types/node` の `node:util` の型が衝突するエラーが 2 件追加される (TypeScript 7.0.2 では出ない)。CI の typecheck ジョブは 5.7 / 5.8 / 5.9 / 6.0 / 7.0.2 の matrix で走る
- 0892 の 3 周目レビューでも「e2e の型の誤りは oxlint type-aware でしか検出されない」と指摘された

## 設計方針

e2e を型検査の対象に加える。専用の `tsconfig.e2e.json` を作り、`tests/e2e/**/*` を対象にする。既存の `tsconfig.json` の `include` に `tests/**/*` を足す案と比較した結果、次の理由で専用 tsconfig にする。

- 専用 tsconfig なら `allowImportingTsExtensions` を有効にし、`src/**/*.d.ts` と `devtools/src/**/*.d.ts` を取り込んで、`tests/e2e/**/*` を型検査の対象にできる。既存の `tsconfig.json` に足すと devtools のソースが root の型検査に入り、ライブラリ本体の型検査にテストの都合が混ざる
- `vp check` の型検査は root の `tsconfig.json` を使うため、専用 tsconfig を `vp check` に含める必要はない。`package.json` に `typecheck:e2e` (`tsc --noEmit -p tsconfig.e2e.json`) を追加し、CI の typecheck ジョブで実行する
- `typecheck:e2e` は `moqt-js` の型解決に `dist` を必要とする (`package.json` の `exports` が `dist/index.d.ts` を指す)。CI では install の `prepare` (`vp pack`) が `dist` を生成するため、追加のビルドは不要
- e2e の型検査は出荷標準の TypeScript 7.0.2 の step だけで実行する。TypeScript 5.7 では `lib.dom` と `@types/node` の衝突が出るため、matrix の 5.7〜6.0 は src の型検査を続ける
- 型エラーは実測 70 件ある。機械的な修正が中心なのでこの issue 内で修正する。修正が想定より大きい場合だけ別 issue に切り出し、その issue の完了後に CI の必須ゲートに加える (型エラーが残ったまま必須ゲートにしない)

## 完了条件

- `tests/e2e/` が `tsc --noEmit` (専用の `typecheck:e2e`) の型検査対象になり、CI の typecheck ジョブの TypeScript 7.0.2 の step で走る
- `tests/e2e/` の型エラーが 0 件であること。修正を別 issue に切り出した場合は、その issue の完了後に CI の必須ゲートに加える
- `vp check` と `vp test --run` が通る

`CHANGES.md` は MOQT RFC ドラフト中のため更新しない (`CODEBASE.md` の特別ルール)。テスト基盤のみの変更のため `### misc` にも記載しない。

## 参照

- `tsconfig.json` の `include`
- `tests/e2e/` の spec と `window.__moqtE2E` の型宣言
- `playwright.config.ts`
- `devtools/tsconfig.json` (`allowImportingTsExtensions` と `paths` の扱い)
- `package.json` の `exports` / `scripts.typecheck`
- `.github/workflows/ci.yml` の `typecheck` ジョブ (TypeScript 5.7〜7.0.2 の matrix)
- `issues/closed/0892-test-relay-discovered-namespace-subscribe.md` の 3 周目レビュー (e2e の型検査範囲)
