# ビルド

Node.js 22.22.2 以降が必要です (package.json の `engines`。CI では 22 / 24 / 26 で検証しています)。ビルドとテストには [Vite+](https://github.com/voidzero-dev/vite-plus) の `vp` コマンドを使います。

```bash
vp install
```

`vp install` は `prepare` スクリプト経由で `vp pack` を実行し、`dist/` に `index.js` と `index.d.ts` を生成します。ソースを変更した後にビルドし直す場合は `vp run build` を実行します。

```bash
vp run build
```

## git 依存として取り込む場合

`github:shiguredo/moqt-js#develop` のように git 依存として取り込む場合、git から取得したツリーには `dist/` が含まれないため、消費側で `prepare` の実行を許可する設定が必要です。

- pnpm は `allowBuilds` に許可を与えないと `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` で失敗します。pnpm 11.19.0 以降はリポジトリ URL 形式 (`moqt-js@git+https://github.com/shiguredo/moqt-js.git`) で指定すると、commit が進んでもキーを書き換えずに済みます
- npm 12 は git 依存のスクリプト実行が既定で無効のため、`--allow-git=root` などを指定します
