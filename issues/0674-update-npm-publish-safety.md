# npm 公開ワークフローにタグとバージョンの一致検証と公開前のテストを入れる

- Created: 2026-09-21
- Completed: {YYYY-MM-DD}
- Branch: feature/update-npm-publish-safety
- Polished: 2026-09-30

## 目的

`.github/workflows/npm-publish.yml` は任意のタグ push で起動し、タグ名と `package.json` の version の一致を検証しない。公開前に実行するテストもワークフロー内になく、`ci` ワークフローのテスト結果とも独立であるため、テストが落ちていても誤ったタグや未更新のバージョンで npm に公開できる経路がある。`AGENTS.md` は GitHub Actions を扱うとき `shiguredo-github-actions` スキルを参照することを求めており、実装時は同スキルに従うこと。

## 現状

`.github/workflows/npm-publish.yml` を確認した結果は次のとおり。

- `on.push.tags` が `"*"` であり、任意のタグ push で起動する。`v` 始まりなどの形式検証も無い
- タグ名 (`github.ref_name`) と `package.json` の version を突き合わせる step が無い。`npm publish` は `package.json` の version をそのまま公開するため、タグと version がずれたまま公開できる
- build job は `vp run build` / `vp lint` / `vp run typecheck` を実行するだけで、`vp test` を実行しない。`ci` ワークフローはタグ push でも実行され `vp test` が回るが、`npm-publish` は `ci` の結果を待たないため、テストが落ちる状態でも公開できる
- `npm-publish-canary` と `npm-publish` は build job の成果物 (`dist/`) を `actions/download-artifact` で受け取って `npm publish` する。検証は build job に置くのが自然である

## 設計方針

- タグ名と `package.json` の version の完全一致を検証する step を追加し、一致しないなら fail させて公開しない。既存タグに `v` プレフィックスは無く (`2026.1.0` / `2026.2.0`)、canary タグは `{version}-canary.{n}` (例: `2026.2.0-canary.1`) である。canary タグのコミットでも `package.json` の version はタグ名と一致しているため、stable / canary を区別せず完全一致 1 本の検証でよい
- build job に `vp test` を追加し、失敗時は公開しない
- 検証 step と `vp test` は build job に置く。build job は `npm-publish-canary` / `npm-publish` の両方から `needs` されるため、1 か所で両方の公開をゲートできる。検証は新規 action を追加せず `run:` step で行う
- action の選定・runner は `shiguredo-github-actions` スキルに従う。既存の action はコミットハッシュ固定 + バージョンコメントの形式を維持する

## 完了条件

- タグ名と `package.json` の version が一致しない場合、build job が fail して公開されない
- 公開前に build job で `vp test` が実行され、失敗時は公開されない
- 正しいタグ (stable: `2026.2.0`、canary: `2026.2.0-canary.1` など) で一致検証を通過し、公開できる
- 検証・テストを通過したとき、ワークフローの全 job が success になる

## 参照

- `.github/workflows/npm-publish.yml` / `package.json`
- `AGENTS.md` (GitHub Actions では `shiguredo-github-actions` スキルを参照すること)

## 解決方法

{未着手}
