# moqt-devtools のデプロイで shaka-player のビルドをキャッシュする

- Created: 2026-11-27
- Completed: {YYYY-MM-DD}
- Branch: feature/update-cache-shaka-player-build
- Polished: 2026-11-27

## 目的

moqt-devtools のデプロイは、毎回 shaka-player の experimental build をゼロから作り直している。2026-11-27 の実測では `build-and-deploy` job の 8 分 47 秒のうち 7 分 37 秒をこのビルドが占めている (run 全体は `slack-notify` を含めて 8 分 57 秒)。shaka-player の commit は固定であり、同じ commit のビルド結果を再利用すればデプロイ時間を短縮できる。

## 現状

- `.github/workflows/deploy-cloudflare.yml` の `build-and-deploy` job は、`shaka-project/shaka-player` を `ef7e1bf63845df228665af0f93a77667fb84f8b0` で checkout し、`npm ci` と `python3 build/all.py --force --release` を毎回実行する。トリガーは `workflow_dispatch` だけである
- 2026-11-27 の [run 45929875158](https://github.com/shiguredo/moqt-js/actions/runs/45929875158) の実測値は次のとおり
  - shaka-player の取得: 4 秒
  - shaka-player の依存インストール (`npm ci`): 37 秒
  - shaka-player の experimental build: 7 分 37 秒
  - Web アプリのビルド: 1 秒
  - Cloudflare Pages へのデプロイ: 11 秒
  - `build-and-deploy` job: 8 分 47 秒
  - run 全体: 8 分 57 秒 (`slack-notify` を含む)
- shaka-player のビルドには Java 21 が必要であり、`actions/setup-java` も毎回実行している
- このワークフローの setup-vp は `cache` を指定しておらず、既定の false のため package-manager の依存キャッシュも無効である。仮に `cache: true` にしても対象は package-manager のストアだけで、`_shaka-player/dist` は復元されない
- デプロイが使うのは `devtools/scripts/vendor-shaka.mjs` が `SHAKA_DIST` からコピーする `shaka-player.experimental.js` と `shaka-player.transmuxer-worker.js` の 2 ファイルだけである。固定 commit のビルドでは前者が 1,391,098 バイト、後者が 133,525 バイト、合計 1,524,623 バイト (約 1.52 MB) である。`_shaka-player/dist` 全体は 42,027,389 バイト (約 42 MB) ある
- `SHAKA_DIST` を指定したときにファイルが欠けている場合、同スクリプトはエラーにする (リポジトリ同梱の gzip へはフォールバックしない)
- 他の workflow (`ci.yml` / `e2e-test.yml` / `npm-publish.yml`) は shaka-player をビルドしない。対象は `deploy-cloudflare.yml` だけである
- `deploy-cloudflare.yml` は `workflow_dispatch` だけで起動する。既定ブランチは `develop` であり、ワークフローが既定ブランチに存在して一度実行された後は、`--ref` で feature ブランチを指定して実行できる

## 設計方針

- GitHub 公式の `actions/cache/restore` と `actions/cache/save` を使い、実際に使う 2 ファイルだけを固定 commit ごとに保存する。`_shaka-player/dist` 全体 (42 MB) は保存しない。`SHAKA_DIST` は従来どおり `_shaka-player/dist` を指す
- キャッシュのキーには shaka-player の固定 commit SHA とキャッシュ形式のバージョンを含める (`shaka-player-<commit>-<version>`)。`restore-keys` は使わず、完全一致だけを復元する。commit を変えたときやビルド環境を変えてバージョンを上げたときは miss させる
- commit SHA とキャッシュ形式のバージョンは `env` で 1 か所に定義し、checkout の `ref` とキャッシュのキーの両方から参照して値のずれを防ぐ
- キャッシュがヒットしたときは shaka-player の checkout、Java のセットアップ、`npm ci`、experimental build を実行しない。ヒットした場合に限り、復元後に 2 ファイルが存在することを確認し、欠けている場合はビルドへフォールバックせず失敗させる
- キャッシュがミスしたときは通常どおりビルドし、ビルドが成功したときだけ保存する。ヒット時に保存しない (`cache-hit` が true のときは保存 step をスキップする)
- キャッシュの restore / save の失敗ではデプロイを止めない。restore の失敗はミスとしてビルドし、save の失敗は警告に留める
- `vp run build:web` と Cloudflare Pages へのデプロイは、キャッシュの有無にかかわらず必ず実行する
- `workflow_dispatch` は信頼済みトリガーであり、既定ブランチのスコープにキャッシュを保存できる。feature ブランチで保存したキャッシュはそのブランチにスコープされ、develop からは復元できない。`on.push` は追加しない (追加すると develop への push ごとに本番デプロイが走る)。このワークフローは PR では起動しないため、PR からキャッシュが保存されることもない
- 検証は、PR 作成後に feature ブランチへ `gh workflow run deploy-cloudflare.yml --ref feature/update-cache-shaka-player-build` を 2 回実行して行う。1 回目はビルドして保存し、2 回目はヒットして shaka のステップがスキップされることを確認する。いずれも Cloudflare Pages のプレビューへデプロイする (本番ブランチは develop のため)。本番の配信内容には影響しない。マージ後の develop は feature ブランチのキャッシュを復元できないため、初回だけ miss してビルドし、その回でキャッシュを保存する
- action の参照は `owner/repo@<40 桁のコミットハッシュ> # vX.Y.Z` の形式にし、採用するバージョンは実装時に最新を確認する
- GitHub Actions を扱うため `shiguredo-github-actions` スキルに従う
- `CODEBASE.md` の「MOQT RFC ドラフト中の特別ルール」に従い、`CHANGES.md` は更新しない

## 完了条件

- 同じ ref の 2 回目以降のデプロイで、shaka-player の checkout、Java のセットアップ、`npm ci`、experimental build が実行されず、キャッシュから `_shaka-player/dist` の 2 ファイルが復元され、`SHAKA_DIST` がそのディレクトリを指す
- キャッシュヒット時も `vp run build:web` と Cloudflare Pages へのデプロイが成功する
- shaka-player の commit を変えたとき、またはキャッシュ形式のバージョンを上げたときにキャッシュが miss し、新しい条件でビルドし直す
- キャッシュがヒットしたのに 2 ファイルが欠けている場合は、古い成果物や同梱の gzip で続行せず失敗する
- キャッシュがミスした場合は通常どおりビルドし、ビルド成功時だけ保存する。ヒット時は保存しない
- feature ブランチで 2 回の `workflow_dispatch` を実行し、1 回目で保存、2 回目でヒットすることを確認して、`build-and-deploy` job の所要時間を before / after で残す
- action の参照が 40 桁のコミットハッシュ固定 + バージョンコメントになっている
- `vp check` と prek の pre-commit hook (YAML の構文検証を含む) が通る

## 参照

- `.github/workflows/deploy-cloudflare.yml`
- `devtools/scripts/vendor-shaka.mjs`
- `package.json` の `build:web` と `devtools/package.json` の `build`
- [run 45929875158](https://github.com/shiguredo/moqt-js/actions/runs/45929875158) の step ごとの実行時間
- open 0821 (同じ `.github/workflows/deploy-cloudflare.yml` を触る。目的は `vp pack` の重複削減で本 issue とは別。先に 0821 がマージされた場合は step の位置を rebase する)
- GitHub の workflow_dispatch のドキュメント (既定ブランチにワークフローが必要なこと、一度実行後は `--ref` で任意のブランチを指定できること)
- GitHub のキャッシュのアクセス制限のドキュメント (既定ブランチのキャッシュは全ブランチから復元でき、feature ブランチのキャッシュはそのブランチにスコープされること)
- `shiguredo-github-actions` スキルの「action の選定」「action の参照形式」「キャッシュ」
