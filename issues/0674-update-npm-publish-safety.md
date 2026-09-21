# npm 公開ワークフローにタグとバージョンの一致検証を入れる

- Created: 2026-09-21
- Completed: {YYYY-MM-DD}
- Branch: feature/update-npm-publish-safety
- Polished: {YYYY-MM-DD}

## 目的

`.github/workflows/npm-publish.yml` は任意のタグ push で起動し、タグ名と `package.json` の version の一致を検証しない。公開前のテスト実行も無いため、誤ったタグや未更新のバージョンで npm に公開できる経路がある。`AGENTS.md` は GitHub Actions を扱うとき `shiguredo-github-actions` スキルを参照することを求めており、実装時は同スキルに従うこと。

## 現状

`.github/workflows/npm-publish.yml` を確認した結果は次のとおり。

- `on.push.tags` が `"*"` であり、任意のタグ push で起動する。`v` 始まりなどの形式検証も無い
- タグ名 (`github.ref_name`) と `package.json` の version を突き合わせる step が無い。`npm publish` は `package.json` の version をそのまま公開するため、タグと version がずれたまま公開できる
- build job は `vp run build` / `vp lint` / `vp run typecheck` を実行するだけで、`vp test` を実行しない。テストが落ちる状態でも公開できる
- `npm-publish-canary` と `npm-publish` は build job の成果物 (`dist/`) を `actions/download-artifact` で受け取って `npm publish` する。検証は build job に置くのが自然である

## 設計方針

- タグ名と `package.json` の version の一致を検証する step を追加し、不一致なら公開せず fail させる。タグの命名規則 (`v` プレフィックスの有無など) はリポジトリの既存タグと `shiguredo-github-actions` スキルに従って決める
- 公開前に `vp test` を実行する
- step の追加位置・action の選定・runner は `shiguredo-github-actions` スキルに従う。既存の action はコミットハッシュ固定 + バージョンコメントの形式を維持する

## 完了条件

- タグ名と `package.json` の version が一致しない場合、公開 job が fail する
- 公開前にテストが実行され、失敗時は公開されない
- 検証を通った正しいタグで公開できる
- ワークフローの全 job が success になる

## 参照

- `.github/workflows/npm-publish.yml` / `package.json`
- `AGENTS.md` (GitHub Actions では `shiguredo-github-actions` スキルを参照すること)

## 解決方法

{未着手}
