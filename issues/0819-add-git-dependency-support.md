# moqt-js を git 依存で取り込めるようにする

- Created: 2026-10-07
- Completed: {YYYY-MM-DD}
- Branch: feature/add-git-dependency-support
- Polished: {YYYY-MM-DD}

## 目的

`moqt-js` の `develop` の先端を `github:shiguredo/moqt-js#develop` の形で取り込みたい。npm の公開版はリリース単位でしか更新されず、`develop` の変更を追えない。現状は git から取得したツリーにビルド成果物が含まれないため import できず、npm の公開版を使うか、ローカルのチェックアウトを `link:` で参照するしかない。

## 現状

- `package.json` は `files` を `["dist"]` とし、`main` / `module` / `types` / `exports` のすべてが `dist/` を指している
- `dist/` は `.gitignore` の対象であり、`git ls-files dist` は空である。git から取得したツリーには `dist/` が存在せず、`exports` が指す `dist/index.js` を解決できない
- `scripts` には `build` (`vp pack`) があるが、`prepare` / `prepack` / `prepublishOnly` は無い
- pnpm 11.7.0 で実測した挙動
  - `pnpm add -E github:shiguredo/moqt-js#develop` で入るのは `LICENSE` / `package.json` / `README.md` だけである。`node_modules/moqt-js/dist` は存在しない
  - pnpm は git ホストされた依存の `prepare` を実行する。`prepack` / `prepublishOnly` は実行しない
  - pnpm 11 は git 依存の `prepare` の実行に `pnpm-workspace.yaml` の `allowBuilds` の許可を求める。許可のキーは解決済みコミットを含む完全な指定子でなければ一致しない
    - 一致する例: `moqt-js@git+https://github.com/shiguredo/moqt-js.git#<commit>`
    - パッケージ名だけの `allowBuilds` は一致しない。`onlyBuiltDependencies` のパッケージ名だけの指定も一致しない
  - `prepare` の実行時、pnpm はそのパッケージの devDependencies も取得してから実行する

## 設計方針

- `package.json` の `scripts` に `"prepare": "vp pack"` を追加する
  - git ホストされた依存で実行されるライフサイクルが `prepare` だけであるため (`prepack` / `prepublishOnly` は git 依存では実行されない)
  - `vp pack` は既存の `build` と同じコマンドであり、`vite.config.ts` の `pack` 設定が `dist/` に `index.js` / `index.d.ts` と Worker のチャンクを出力する
- `files` と `exports` は変更しない
- 副作用として受け入れること
  - `prepare` は moqt-js 自身の `vp install` でも実行される。ローカル開発で毎回 `vp pack` が走るため `vp install` が遅くなる。避けたい場合は `vp install --ignore-scripts` を使う
  - 消費側は `pnpm-workspace.yaml` の `allowBuilds` に解決済みコミット込みのキーを書く必要がある。`develop` が進んでロックファイルの解決コミットが変わると、消費側がキーを更新する
  - 消費側の `vp install` は moqt-js の devDependencies を取得してから `vp pack` を実行する。インストール時間が伸びる
- 採らない代替案
  - `dist/` をコミットする: 生成物を git 管理下に置くと差分が壊れやすく、レビューも困難になる
  - npm の canary 版を指定する: `develop` の先端を追う用途には合わない。canary はリリース単位である

## 完了条件

- `package.json` の `scripts` に `prepare` があること
- クリーンなチェックアウトで `vp install` を実行し、`dist/index.js` と `dist/index.d.ts` が生成されること

  ```bash
  git clone --branch develop https://github.com/shiguredo/moqt-js.git /tmp/moqt-js-probe
  cd /tmp/moqt-js-probe
  vp install
  ls dist/index.js dist/index.d.ts
  ```

- git 依存として取り込んだときに `dist/index.js` が存在すること

  ```bash
  # 検証用の空プロジェクトで pnpm-workspace.yaml に allowBuilds を書いてから実行する
  # キーは解決済みコミットを含む指定子にする (例: moqt-js@git+https://github.com/shiguredo/moqt-js.git#<commit>)
  vp add -E "github:shiguredo/moqt-js#develop"
  ls node_modules/moqt-js/dist/index.js
  ```

- `vp check` / `vp test run` / `vp run build:devtools` が通ること
- `CHANGES.md` の `## develop` に `[ADD]` として記載すること

## 解決方法

{未着手}
