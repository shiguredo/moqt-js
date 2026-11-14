# CI の各 job で二重になっている `vp pack` を整理する

- Created: 2026-10-07
- Completed: {YYYY-MM-DD}
- Branch: feature/update-ci-redundant-build
- Polished: 2026-11-15
- Refreshed: 2026-11-14

## 目的

`package.json` の `scripts` に `prepare` (`vp pack`) を追加したため、install が実際に依存を解決するときに `dist/` が生成される。その結果、CI の各 job で install の `prepare` と明示的な `vp run build` が同じ pack を二重に実行するようになった。pack の回数を戻し、CI の時間を無駄にしない。

## 現状

- `voidzero-dev/setup-vp` (v1.21.2) は `run-install` の既定が true であり、`vp install` を無引数で実行する。ワークフローに `vp install` が無くても job の最初に install が走る。クリーンチェックアウトでは依存の解決が起きるため `prepare` 経由で `vp pack` が 1 回実行される (node_modules が揃った状態での同じロックファイルの再 install は `Already up to date` になり `prepare` は走らない。pnpm 11.18.0 と 12.18.0 で実測済み)
- setup-vp の `cache: true` が復元するのは package-manager のストアだけであり、`node_modules` や `dist/` は復元されない。どの job も `node_modules` の無い状態から install するため、install の `prepare` は job ごとに必ず 1 回走る
- `lint` job の `vp run build` は、`vp check` の型検査が `tests/e2e` の spec の `moqt-js` import を解決できるようにするために入れたものである (closed 0773-test-lint-job-requires-build-output)。install の `prepare` で `dist/` ができるため、この `vp run build` は役割が無くなっている
- `build` job (Node 26 / 24 / 22) は `vp test` と `vp run build` を実行する。install の pack と合わせて 1 job あたり 2 回 pack する
- `typecheck` job は setup-vp の install (書き換え前の `devDependencies.typescript`) と、`package.json` の typescript を書き換えた後の `vp install --no-frozen-lockfile` で pack する。matrix の `7.0.2` は `package.json` の typescript と同じため書き換えが no-op になり、2 回目の install は `Already up to date` で pack せず、pack は 1 回になる。それ以外の matrix では 2 回 pack し、型検査に使うのは書き換え後の 1 回分だけで、書き換え前の 1 回は無駄になる
- `e2e` job は setup-vp の install の後に明示的な `vp install` を実行するが、2 回目の install は no-op のため pack しない。`vp run e2e-test` と `vp run e2e-test:production` (どちらも `vp run build` を含む) と合わせて 3 回 pack する
- `e2e-test.yml` の `relay` job も同じ構成で、`TEST_MOQT_URI` が設定されている場合に限り、install の後に明示的な `vp install` (no-op) と `vp run build` を実行し、Playwright を直接動かす。install の pack と `vp run build` の合計で 2 回 pack する (`TEST_MOQT_URI` が未設定の場合は setup-vp の install だけが走り、pack は 1 回)
- `ci.yml` の `webkit-playout` job (macOS) は setup-vp の install と `vp run build` を実行する。install の pack と合わせて 2 回 pack する
- `npm-publish.yml` の `build` job は `vp run build` / `vp lint` / `vp run typecheck` を実行する。install の pack と合わせて 2 回 pack する
- `deploy-cloudflare.yml` は setup-vp の install の後に明示的な `vp install --frozen-lockfile` (no-op) を実行し、`vp run build` / `vp run build:devtools` を実行する。pack は install と `vp run build` の 2 回

## 設計方針

- install の `prepare` を前提にする job からは、明示的な `vp run build` を削除する。`dist/` が要る検証 (`vp check` / `vp lint` の型検査、Playwright の spec の `moqt-js` import) は install の pack で満たされる
- install に `--ignore-scripts` を入れる job では `prepare` が走らないため、明示的な `vp run build` を残す。どちらに寄せるかは job ごとに決め、その理由をコメントに残す
- job ごとの方向
  - `lint`: `vp run build` を削除する。step のコメント (TS2307 の回避目的) は「install の `prepare` が `dist/` を作るため明示的なビルドは不要」という内容に更新する。job のコメント (`ライブラリのビルド (vp run build) を含むため ubuntu-slim では足りない`) も、install の `prepare` が `vp pack` を実行するため ubuntu-slim では足りない、という内容に更新する
  - `build`: `vp run build` を削除する。install の pack がビルド検証になる
  - `typecheck`: setup-vp の `run-install` を `false` にして、書き換え後の 1 回の install に寄せる。`run-install` に `args: ["--ignore-scripts"]` を渡す案は、matrix の `7.0.2` で書き換えが no-op になり 2 回目の install も no-op になるため、pack が 0 回になる。typecheck job の `vp run typecheck` (`tsc --noEmit`) は `tsconfig.json` の `include` が `src/**/*` のみのため dist を必要としないが、`prepare` の `vp pack` がマトリクス版の TypeScript で d.ts 生成に成功する検証も兼ねているため、pack を 0 回にはしない (ci.yml のコメント: nightly はこの pack が落ちるため外している)
  - `e2e` / `relay`: setup-vp の install で足りるため、明示的な `vp install` を削除する (no-op の重複)。`package.json` の `e2e-test` / `e2e-test:production` の `vp run build &&` は両方外すか両方残すかを決める (片方だけ外すと e2e job の pack が 2 回になり、完了条件の 1 回 / 3 回に合わない)。`e2e-test.yml` の `relay` job の `vp run build` を外すかは、`vp exec playwright test` 単体で動くかを確認してから決める。外す場合、install を経ずに実行する開発者の前提が変わるため、`docs/DEVELOPMENT.md` の「E2E テスト」節に先に `vp install` が必要な旨を書く (「ビルド」節の更新は closed 0822 で対応済み。README は `docs/DEVELOPMENT.md` を参照するだけ)。同じく外す場合、`ci.yml` の e2e job のコメント (`dist を消費するアプリのため、vp run build を含むスクリプトで実行する`) も、install の `prepare` が `dist/` を生成するため明示的なビルドを含めない、という内容に更新する
  - `webkit-playout`: `vp run build` を削除する。install の pack で `dist/` ができる
  - `npm-publish` の `build`: `vp run build` を削除する。`vp run typecheck` は dist を必要としないが、`vp lint` は `tests/e2e` の `moqt-js` import の型検査で `dist/` を必要とする。どちらも install の pack が `dist/` を生成するため、明示的なビルドは不要で、公開する `dist/` も install の pack で生成される
  - `deploy-cloudflare`: `vp run build` を削除する。`vp run build:devtools` は devtools/vite.config.ts の alias が `moqt-js` を `src/index.ts` へ向けるため、ライブラリの `dist/` は不要。`--frozen-lockfile` の意味 (手動デプロイ時の lockfile 変更検出) を保つため、setup-vp の `run-install` の `args` に `--frozen-lockfile` を移し、明示的な `vp install` を削除して install を 1 回に寄せる
- 明示的な `vp install` を持つ job の再 install は no-op で pack しない (pnpm 実測) が、install の重複自体も時間の無駄であるため、上記のとおり install を 1 回に寄せる
- 検証の範囲 (何をテスト・lint・型検査するか) は変えない。pack と install の重複だけを減らす。GitHub Actions を扱うため `shiguredo-github-actions` スキルに従う
- `CHANGES.md` は CI のみの変更であり、`CODEBASE.md` の「MOQT RFC ドラフト中の特別ルール: CHANGES.md を更新しない」に従い更新しない

## 完了条件

- 各 job の `vp pack` の実行回数が、次に定める必要な回数を超えない (ただし 0 回にしない)。回数は CI ログで `vp pack` の実行を数えて確認する
  - 必要な回数: `lint` / `build` / `typecheck` / `webkit-playout` / `npm-publish` の `build` / `deploy-cloudflare` は 1 回。`e2e` は 1 回 (両方のスクリプトの `vp run build &&` を外した場合) または 3 回 (両方残す判断をした場合。例: インストールし直さずに `vp run e2e-test` / `vp run e2e-test:production` を実行する開発者の利便性を残す)。`relay` は 1 回 (明示的な `vp run build` を削除した場合、または `TEST_MOQT_URI` が未設定の場合) または 2 回 (`TEST_MOQT_URI` が設定されており、残す判断をした場合)
  - 1 回を超えた job では、その回数にした理由をコメントに残し、検証範囲を変えていないことを明記する
- 各 job の変更には、pack の回数をその回数にした理由のコメントを残すこと
- `lint` job の `vp check` が `dist/` の欠落で失敗しないこと (`TS2307` を出さない)
- `lint` / `build` / `typecheck` / `e2e` / `webkit-playout` / `relay` の各 job と `npm-publish` の `build` job が通ること
- `deploy-cloudflare` が `workflow_dispatch` で通ること
- `CHANGES.md` は `CODEBASE.md` の「MOQT RFC ドラフト中の特別ルール: CHANGES.md を更新しない」により更新しないこと

## 参照

- `.github/workflows/ci.yml` / `.github/workflows/e2e-test.yml` / `.github/workflows/npm-publish.yml` / `.github/workflows/deploy-cloudflare.yml`
- `package.json` の `scripts` (`prepare` / `build` / `e2e-test` / `e2e-test:production` / `e2e-test:relay`)
- `docs/DEVELOPMENT.md` の「ビルド」節・「E2E テスト」節
- `tsconfig.json` / `devtools/vite.config.ts`
- closed 0773-test-lint-job-requires-build-output (`lint` job に `vp run build` を入れた理由。install の `prepare` が追加される前の前提で書かれている)
- closed 0819 (`prepare` を追加した issue。install のたびに `vp pack` が走る副作用と npm-publish の `--ignore-scripts` が書かれている)
- open 0673 (CI の検証範囲を広げる issue。本 issue は範囲を変えずに重複だけを減らす。0673 は ci.yml の job を変更し得るため、先に片付けるか変更箇所を調整する)
- open 0674 (npm-publish.yml の build job に `vp test` を追加する issue。同じ build job を触るため、step の構成を調整する)
- closed 0822 (README のビルド節に `prepare` を反映する issue。「ビルド」節の内容は `docs/DEVELOPMENT.md` にあり 0822 で対応済み、「E2E テスト」節の E2E 部分は本 issue の責務)

## 解決方法

{未着手}
