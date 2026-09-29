# CI の lint ジョブが dist を作らずに vp check を実行し、e2e の spec の型解決に失敗する

- Created: 2026-09-29
- Completed: 2026-09-29
- Branch: feature/fix-lint-job-build-output
- Polished: 2026-09-29

## 目的

`.github/workflows/ci.yml` の `lint` ジョブは `vp check` だけを実行し、`vp run build` を行わない。`vp check` の型検査は `tests/e2e/*.spec.ts` も対象に含み、`tests/e2e/devtools-authorization-token.spec.ts` は `import { C4M } from "moqt-js"` でパッケージ自身を参照する。`package.json` の `exports` は `dist/index.d.ts` を指すため、`dist` が無い CI では `TS2307: Cannot find module 'moqt-js' or its corresponding type declarations.` で失敗する。この spec は PR #395 で追加されたため、以降の develop の `lint` ジョブは常に赤い。

## 現状

- `.github/workflows/ci.yml` の `lint` ジョブは `voidzero-dev/setup-vp` の後に `vp check` を実行するだけである (コメントに「整形・lint・型をまとめて検証する」「型は別 job で複数バージョンを検証する」とある)
- `typecheck` ジョブは `tsconfig.json` の `include` が `src/**/*` のため `tests/e2e` を対象にせず、この問題は起きない
- `e2e` ジョブは `vp run e2e-test` の中でビルドするため、この問題は起きない
- `tests/e2e/devtools-authorization-token.spec.ts` は `import { C4M } from "moqt-js"` で `src/index.ts` の `export * as C4M from "./c4m"` を参照する
- 2026-09-29 の PR #421 (0658) の CI で `lint` ジョブが実際に失敗した (`error: Lint or type issues found` / `tests/e2e/devtools-authorization-token.spec.ts:2:21`)
- ローカルでは `dist` が存在するため再現しない。`dist` を削除すると再現する

## 設計方針

- `lint` ジョブの `vp check` の前に `vp run build` を追加する。`vp check` の型検査がパッケージ自身の import を解決できるようにするのが目的であり、ビルド成果物の検証は `build` ジョブが担う
- `vp check` を 2 回に分けたり、`tests/e2e` を型検査の対象外にしたりしない。spec の import は利用者と同じ形であり、型解決の失敗は検出したい
- 対象は `.github/workflows/ci.yml` のみとする。`package.json` の `exports`、`tsconfig.json` の `include`、spec の import は変更しない
- `CHANGES.md` は CI の修正であり利用者向けの変更では無いため更新しない

## 完了条件

- `dist` を削除した状態で `npx vp check` が失敗し、`npx vp run build` の後に `npx vp check` が通ることを実測する
- `lint` ジョブに `vp run build` が入る
- `npx vp run e2e-test` が通る (ビルド手順が変わっても e2e の前提が崩れないこと)

## 参照

- `.github/workflows/ci.yml` の `lint` / `typecheck` / `e2e` ジョブ
- PR #421 (0658) の CI で観測した `TS2307`
- PR #395 (c4m から取り込んだトークンを Token Type 0x01 (CAT) で送る) で spec が追加された

## 解決方法

`.github/workflows/ci.yml` の `lint` ジョブの `vp check` の前に `vp run build` を追加した。`tests/e2e` の spec は `package.json` の `exports` 経由で `moqt-js` を import するため、`dist` が無いと `vp check` の型検査が `TS2307: Cannot find module 'moqt-js' or its corresponding type declarations.` で失敗する。`lint` ジョブにビルドの手順を足すことで、spec の import を利用者と同じ形のまま型解決できるようにした。

`dist` を削除した状態で `npx vp check` が失敗することと、`npx vp run build` の後に `npx vp check` が通ることを実測した。`vp check` を 2 回に分けたり `tests/e2e` を型検査の対象外にしたりはしていない (spec の import の型解決は検出したいため)。`package.json` の `exports`、`tsconfig.json` の `include`、spec の import は変更していない。CI の修正であり利用者向けの変更では無いため `CHANGES.md` は更新していない。

`npx vp check` / `npx vp test --run` が通る。
