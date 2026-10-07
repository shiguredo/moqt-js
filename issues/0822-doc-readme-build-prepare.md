# README のビルド手順に `prepare` による `dist/` 生成を反映する

- Created: 2026-10-07
- Completed: {YYYY-MM-DD}
- Branch: feature/update-readme-build-prepare
- Polished: 2026-10-08

## 目的

`package.json` の `scripts` に `prepare` (`vp pack`) を追加したため、`vp install` だけで `dist/` が生成される。README の「ビルド」節は `vp install` と `vp run build` を並べたままで、`dist/` が install で作られることと、git 依存として取り込むときに必要な設定が読み取れない。

## 現状

- README の「ビルド」節は `vp install` と `vp run build` の 2 行だけである。`vp install` が `prepare` 経由で `vp pack` を実行することは書かれていない
- `package.json` の `scripts` に `prepare` (`vp pack`) があり、クリーンなチェックアウトの `vp install` で `dist/index.js` と `dist/index.d.ts` が生成される
- git 依存 (`github:shiguredo/moqt-js#develop`) として取り込む場合、pnpm は `allowBuilds` の許可 (キーは解決済みの depPath) が、npm 12 は `allow-git` の既定が `none` のため `--allow-git=root` などが必要になる。README にはこの注意が無い
- `CHANGES.md` の `## develop` の `[ADD]` には、`prepare` の追加と消費側に必要な設定が書かれている

## 設計方針

- 「ビルド」節に、`vp install` が `prepare` 経由で `vp pack` を実行して `dist/` を生成することを書く。`vp run build` はソースを変更した後に明示的にビルドし直すときに使うことを書く
- git 依存として取り込むときに必要な設定 (pnpm の `allowBuilds` / npm 12 の `allow-git`) は、`## インストール` の既存の内容 (`pnpm add -E moqt-js`) と重複しない位置に書く。内容は closed 0819 の検証結果と `CHANGES.md` の `## develop` の対応する `[ADD]` に基づく
- `README.md` のみを変更する。実装・ワークフローは変更しない
- ドキュメントを扱うため `shiguredo-doc` スキルに従う

## 完了条件

- README を読めば `vp install` だけで `dist/` が生成されることが分かる
- git 依存として取り込むときに必要な設定 (pnpm の `allowBuilds` / npm 12 の `allow-git`) が README のどこかに書かれている
- `vp check` が通ること (markdown の整形を含む)

## 参照

- `README.md` の「ビルド」節・「インストール」節
- `package.json` の `scripts`
- closed 0819 (moqt-js を git 依存で取り込めるようにする。`prepare` と消費側の設定を追加した)

## 解決方法

{未着手}
