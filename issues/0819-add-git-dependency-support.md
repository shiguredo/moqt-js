# moqt-js を git 依存で取り込めるようにする

- Created: 2026-10-07
- Completed: {YYYY-MM-DD}
- Branch: feature/add-git-dependency-support
- Polished: 2026-10-07

## 目的

`moqt-js` の `develop` の先端を `github:shiguredo/moqt-js#develop` の形で取り込みたい。npm の公開版はリリース単位でしか更新されず、`develop` の変更を追えない。現状は git から取得したツリーにビルド成果物が含まれないため import できず、npm の公開版を使うか、ローカルのチェックアウトを `link:` で参照するしかない。

## 現状

- `package.json` は `files` を `["dist"]` とし、`main` / `module` / `types` / `exports` のすべてが `dist/` を指している
- `dist/` は `.gitignore` の対象であり、`git ls-files dist` は空である。git から取得したツリーには `dist/` が存在せず、`exports` が指す `dist/index.js` を解決できない
- `scripts` には `build` (`vp pack`) があるが、`prepare` / `prepack` / `prepublishOnly` は無い
- pnpm 11 系で確認した挙動 (報告者の環境は 11.7.0、リポジトリの `packageManager` は `pnpm@11.18.0`。`packageManager` の固定が無い検証用プロジェクトで `vp` が使う pnpm 12.9.1 でも同じ結果を確認した)
  - `pnpm add -E github:shiguredo/moqt-js#develop` で入るのは `LICENSE` / `package.json` / `README.md` だけである。`node_modules/moqt-js/dist` は存在しない。`github:` は codeload の tarball として取得され、`files` の範囲だけが展開されるためである
  - pnpm は git ホストされた依存の `prepare` を実行する。実行の主体は pnpm が取得したツリー内で走らせる入れ子の install であり、その install が root の `prepare` を実行する。pnpm は続けて `prepack` も実行する (`prepublishOnly` は実行しない)
  - pnpm は git 依存のビルド許可を `allowBuilds` で判定する。許可が無いと `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` で install が失敗する (警告ではなく失敗)
  - `allowBuilds` のキーは解決済みの depPath との完全一致が要る。`github:` 依存の depPath は codeload の tarball URL になるため、キーは `moqt-js@https://codeload.github.com/shiguredo/moqt-js/tar.gz/<commit>` の形になる (pnpm はこのキーをエラーの hint に印字する)。パッケージ名だけの指定は一致しない
  - pnpm 11 では `allowBuilds` が `onlyBuiltDependencies` / `onlyBuiltDependenciesFile` / `neverBuiltDependencies` / `ignoredBuiltDependencies` を置き換えており、旧設定はビルド許可の判定に使われない
  - `prepare` の実行時、pnpm はそのパッケージの devDependencies も取得してから実行する
- `npm publish` は `prepublishOnly` → `prepack` → `prepare` の順にスクリプトを実行する (実測)。`.github/workflows/npm-publish.yml` の `npm-publish` / `npm-publish-canary` は `voidzero-dev/setup-vp` を使わず `vp install` も実行しないため、`vp` が PATH に無く `node_modules` も無い

## 設計方針

- `package.json` の `scripts` に `"prepare": "vp pack"` を追加する
  - git 依存の取得時にビルドを走らせるフックとして `prepare` を使う。npm の git 依存の取得 (pacote) が実行するのは `prepare` だけであり、pnpm も入れ子の install 経由で `prepare` を実行する。pnpm は `prepack` も実行するが、npm 側では `prepare` しか走らないため `prepare` に一本化する
  - `vp pack` は既存の `build` と同じコマンドであり、`vite.config.ts` の `pack` 設定が `dist/` に `index.js` / `index.d.ts` と Worker のチャンクを出力する
- `.github/workflows/npm-publish.yml` の `npm publish` に `--ignore-scripts` を付ける
  - `npm publish` は `prepare` を実行するため、`prepare` の追加だけを入れると `vp` の無い公開 job で `vp: command not found` になり、タグ push でのリリース (canary 含む) が止まる
  - 公開する `dist/` は `build` job の artifact から展開済みなので、公開時にスクリプトを走らせる必要が無い (`npm publish --ignore-scripts` が `prepublishOnly` / `prepack` / `prepare` を実行しないことを実測で確認済み)
  - `npm-publish-canary` と `npm-publish` の両方に付ける
- `files` と `exports` は変更しない
- 副作用として受け入れること
  - `prepare` は moqt-js 自身の `vp install` でも実行される。ローカル開発で毎回 `vp pack` が走るため `vp install` が遅くなる。避けたい場合は `vp install --ignore-scripts` を使う
  - CI の各 job も install のたびに `vp pack` を実行する (`vp run build` と合わせて二重に pack する分、時間が伸びる)。`typecheck` job は `devDependencies.typescript` を差し替えて `vp install` するため、`vp pack` (dts 生成を含む) もその TypeScript で走る
  - 消費側は `allowBuilds` の許可が必要になる。未許可だと install が `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` で失敗する
    - リポジトリ URL 形式 (`moqt-js@git+https://github.com/shiguredo/moqt-js.git`) は pnpm 11.19.0 以降なら `github:` の tarball 取得にも一致し、commit が進んでも書き換え不要である (pnpm の Build Settings の `allowBuilds` 節)
    - それ未満の pnpm では解決済み depPath の完全一致が要るため、`develop` が進むと消費側がキーを更新する
  - 消費側の `vp install` は moqt-js の devDependencies を取得してから `vp pack` を実行する。インストール時間が伸びる
- 採らない代替案
  - `dist/` をコミットする: 生成物を git 管理下に置くと差分が壊れやすく、レビューも困難になる
  - npm の canary 版を指定する: `develop` の先端を追う用途には合わない。canary はリリース単位である

## 完了条件

- `package.json` の `scripts` に `prepare` があること
- `.github/workflows/npm-publish.yml` の `npm publish` が `--ignore-scripts` 付きになっていること。`vp` の無い状態で公開がスクリプトを実行しないこと (`npm publish --dry-run --ignore-scripts` が `prepare` / `prepack` / `prepublishOnly` を実行しないことで確認できる)
- クリーンなチェックアウトで `vp install` を実行し、`dist/index.js` と `dist/index.d.ts` が生成されること

  ```bash
  # develop の先端はマージされるまで prepare を持たないため、検証は実装ブランチ (Branch: のブランチ) で行う
  git clone --branch <実装ブランチ> https://github.com/shiguredo/moqt-js.git /tmp/moqt-js-probe
  cd /tmp/moqt-js-probe
  vp install
  ls dist/index.js dist/index.d.ts
  ```

- git 依存として取り込んだときに `dist/index.js` が存在すること

  ```bash
  # 検証用の空プロジェクトで実行する
  # 1 回目は allowBuilds が無いため ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED で失敗する。
  # エラーが印字するキーを pnpm-workspace.yaml の allowBuilds に書いて再実行する
  # (リポジトリ URL 形式を使う場合は moqt-js@git+https://github.com/shiguredo/moqt-js.git)
  vp add -E "github:shiguredo/moqt-js#<実装ブランチ>"
  ls node_modules/moqt-js/dist/index.js
  ```

- `vp check` / `vp test run` / `vp run build:devtools` が通ること
- `CHANGES.md` の `## develop` に `[ADD]` として記載すること

## 解決方法

{未着手}
