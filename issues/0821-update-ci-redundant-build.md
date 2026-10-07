# CI の各 job で二重になっている `vp run build` を整理する

- Created: 2026-10-07
- Completed: {YYYY-MM-DD}
- Branch: feature/update-ci-redundant-build
- Polished: {YYYY-MM-DD}

## 目的

`package.json` の `scripts` に `prepare` (`vp pack`) を追加したため、install が実際に依存を解決するときに `dist/` が生成される。その結果、CI の各 job で install の `prepare` と明示的な `vp run build` が同じ pack を二重に実行するようになった。pack の回数を戻し、CI の時間を無駄にしない。

## 現状

- `voidzero-dev/setup-vp` は `run-install` の既定が true であり、ワークフローに `vp install` が無くても job の最初に install が走る。クリーンチェックアウトでは依存の解決が起きるため `prepare` 経由で `vp pack` が 1 回実行される (同じロックファイルでの再 install は `Already up to date` になり `prepare` は走らない)
- `lint` job の `vp run build` は、`vp check` の型検査が `tests/e2e` の spec の `moqt-js` import を解決できるようにするために入れたものである (closed 0773)。install の `prepare` で `dist/` ができるため、この `vp run build` は役割が無くなっている
- `build` job (Node 26 / 24 / 22) は `vp test` と `vp run build` を実行する。install の pack と合わせて 1 job あたり 2 回 pack する
- `typecheck` job は `setup-vp` の install (書き換え前の `devDependencies.typescript`) と、`package.json` の typescript を書き換えた後の `vp install --no-frozen-lockfile` で 2 回 pack する。1 回目は検証に使わない版で pack しており無駄になる
- `e2e` job は `vp install` と `vp run e2e-test` (`vp run build` を含む) を実行する。install の pack と合わせて 2 回 pack する
- `npm-publish.yml` の `build` job は `vp run build` / `vp lint` / `vp run typecheck` を実行する。install の pack と合わせて 2 回 pack する
- `e2e-test.yml` の `relay` job は `vp install` と `vp run e2e-test:relay` (`vp run build` を含む) を実行する。2 回 pack する
- `deploy-cloudflare.yml` は `vp install --frozen-lockfile` / `vp run build` / `vp run build:devtools` を実行する。install の pack と合わせて `vp pack` が 2 回走る

## 設計方針

- install の `prepare` を前提にする job からは、明示的な `vp run build` を削除する。`dist/` が要る検証 (`vp check` など) は install の pack で満たされる
- install に `--ignore-scripts` を入れる job では `prepare` が走らないため、明示的な `vp run build` を残す。どちらに寄せるかは job ごとに決め、その理由をコメントに残す
- `typecheck` job は `setup-vp` の `run-install` を無効にして 1 回の install に寄せるか、`run-install` に `args: --ignore-scripts` を渡して書き換え後の 1 回だけ pack する
- `package.json` の `e2e-test` / `e2e-test:relay` の `vp run build &&` を外すかは、`vp exec playwright test` 単体で動くかを確認してから決める。install を経ずに実行する開発者の前提が変わるため、外すなら README のテスト手順も合わせる
- 検証の範囲 (何をテスト・lint・型検査するか) は変えない。pack の回数だけを減らす。GitHub Actions を扱うため `shiguredo-github-actions` スキルに従う
- `CHANGES.md` は CI のみの変更のため `### misc` に記載する

## 完了条件

- 各 job の `vp pack` の実行回数が、その job の検証に必要な回数を超えない (job ごとに何回にするかを決め、コメントに理由を残す)
- `lint` job の `vp check` が `dist/` の欠落で失敗しないこと (`TS2307` を出さない)
- `lint` / `build` / `typecheck` / `e2e` / `relay` の各 job と `npm-publish` の `build` job が通ること
- `CHANGES.md` の `## develop` の `### misc` に変更を記載すること

## 参照

- `.github/workflows/ci.yml` / `.github/workflows/e2e-test.yml` / `.github/workflows/npm-publish.yml` / `.github/workflows/deploy-cloudflare.yml`
- `package.json` の `scripts` (`prepare` / `build` / `e2e-test` / `e2e-test:relay`)
- closed 0773 (`lint` job に `vp run build` を入れた理由)
- closed 0673 (CI の検証範囲を広げる issue。本 issue は範囲を変えずに重複だけを減らす)

## 解決方法

{未着手}
