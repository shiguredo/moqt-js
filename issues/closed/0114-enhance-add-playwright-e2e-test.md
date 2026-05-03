# Playwright による WebTransport 接続 E2E テストを追加する

Created: 2026-04-29
Completed: 2026-04-29
Model: Opus 4.7

## 概要

`@playwright/test` 1.59.1 と `e2e-test*` scripts は `package.json` に既に定義されているが、`playwright.config.ts` も spec ファイルも未作成で実体が無い。実 MOQT サーバ (Sora MOQT 等) に対する WebTransport 接続を最小スコープで自動検証する E2E 基盤を導入する。

## 根拠

- 高レベル API の `authorizationToken` 露出 (issue 0112) と SETUP Option 配線 (issue 0098) は単体テストで検証済みだが、実サーバ相手の接続成立までは未検証。
- GitHub Actions に `TEST_MOQT_HTTPS_URI` / `TEST_MOQT_AUTH_TOKEN` が secrets として用意済み。
- moqt-js は WebTransport over HTTPS のみ。WebTransport は Chromium 系のみ対応。

## スコープ

- WebTransport 接続確立まで (`createMediaPublisher` / `createMediaSubscriber` が `connect()` を完了する) を assert する
- メディア (`getUserMedia`) は呼ばない。`MediaPublisher.start()` も呼ばない
- Authorization Token は環境変数で渡す (`TEST_MOQT_AUTH_TOKEN`)
- ブラウザは Chromium のみ
- CI 実行は `workflow_dispatch` のみ (手動)
- 自己署名証明書サーバへの対応 (`serverCertificateHashes`) は本 issue では対象外

## 変更内容

### Playwright 基盤

- `playwright.config.ts` を新設する
  - `testDir: ./tests/e2e`、`testMatch: /.*\.spec\.ts$/`
  - `projects`: `chromium` 1 つだけ (既存 `e2e-test` script の `--project='chromium'` と一致)
  - `webServer` で `vp dev tests/e2e --port 5175` を起動
  - `use.ignoreHTTPSErrors: true`
  - `timeout: 10_000` (CLAUDE.md デバッグ timeout 制約に揃える)

### E2E 用最小ページ

- `tests/e2e/` 以下に独立 vite アプリを新設する (`examples/` と同じ構造)
  - `package.json`、`tsconfig.json`、`vite.config.ts` (port 5175)
  - `index.html` (UI 無し、`<div id="status">` のみ)
  - `main.ts` で `window.__moqtE2E.connectPublisher` / `connectSubscriber` を露出する
    - `createMediaPublisher` / `createMediaSubscriber` を呼んで `Session` の `connected` 到達まで進める
    - メディアストリームや `start()` は呼ばず、リソースは即時 `close()` する

### Spec

- `tests/e2e/connect.spec.ts` を新設する
  - `process.env.TEST_MOQT_HTTPS_URI` 未設定時は `test.skip`
  - Publisher 接続成功テスト
  - Subscriber 接続成功テスト
  - `TEST_MOQT_AUTH_TOKEN` がある場合は `authorizationToken` を渡す経路を通す

### CI

- `.github/workflows/e2e.yml` を新設する
  - `on: workflow_dispatch`
  - `runs-on: ubuntu-24.04`
  - `voidzero-dev/setup-vp@v1` で Node 25
  - `pnpm exec playwright install --with-deps chromium`
  - `vp run build` 後に `pnpm run e2e-test`
  - 失敗時のみ `actions/upload-artifact@v5` で `playwright-report/` をアップロード
  - `actions/checkout@v6`

### .gitignore

- `playwright-report/`、`test-results/`、`tests/e2e/node_modules/`、`tests/e2e/dist/` を追加

## 影響範囲

- 新規: `playwright.config.ts`、`tests/e2e/{package.json,tsconfig.json,vite.config.ts,index.html,main.ts,connect.spec.ts}`、`.github/workflows/e2e.yml`
- 変更: `.gitignore`、`CHANGES.md`

## 補足

- ユーザーが言及した `microsoft/playwright-cli` は archived。現在は `@playwright/test` に CLI 機能が統合されているため、本 issue は `@playwright/test` を前提とする。
- WebTransport の Firefox / WebKit サポートは未提供のため、Chromium 以外は対象外とする。

## 解決方法

ローカルで通るところまでを本コミットで実装。CI ワークフロー (`.github/workflows/e2e.yml`) は別 issue で扱う。

- `pnpm-workspace.yaml` の `packages` に `tests/e2e` を追加し、独立 Vite アプリ (`moqt-js-e2e`) として workspace に組み込んだ。
- `tests/e2e/{package.json,tsconfig.json,vite.config.ts,index.html,main.ts,connect.spec.ts}` を新設した。
  - `vite.config.ts` は port 5180 (`strictPort: true`) で `examples` と同じく `moqt-js` を `../../src/index.ts` へ alias。
  - `main.ts` は `window.__moqtE2E.connectSession()` を露出するだけで、`getUserMedia` も `MediaPublisher.start()` も使わない。`connect()` を直接叩いて `Session.state` を読み、`session.close()` で後始末する。Authorization Token は USE_VALUE 形式 (UTF-8 encode) で渡す。
  - `connect.spec.ts` は `TEST_MOQT_HTTPS_URI` 未設定時に `test.skip`、`TEST_MOQT_AUTH_TOKEN` 未設定時にトークン経路の spec のみ skip する。
- `playwright.config.ts` をリポジトリ直下に新設した。
  - `process.loadEnvFile` (Node 20.12+) で `.env` を直接読み込み、dotenv パッケージへの依存は持たない。
  - `webServer.command` は `pnpm --filter moqt-js-e2e dev`、`url` は `http://localhost:5180`。Vite は `localhost` (IPv6 経由) で listen するため `127.0.0.1` ではなく `localhost` を指定する。
  - Chromium 1 プロジェクト構成。`timeout: 10_000` で CLAUDE.md のデバッグ timeout 制約に揃えた。
- `.env.example` を新設して `TEST_MOQT_HTTPS_URI` / `TEST_MOQT_AUTH_TOKEN` のテンプレを置き、`.gitignore` に `.env*` (`!.env.example` で example のみ許可) / `playwright-report/` / `test-results/` を追加した。
- `tests/e2e/vite.config.ts` の `define` で `__MOQT_JS_VERSION__` を埋め込む (ルート vite.config.ts と同じ扱い)。これが無いと `src/version.ts` の評価で `ReferenceError` になり module 全体の評価が失敗していた。
- `vp run typecheck` / `vp lint` / `vp test` (394 tests) が通ることを確認。`pnpm run e2e-test` は環境変数未設定時に 2 件 `skipped` で正常終了し、`.env` を設定した実環境では 2 件 (token なし接続 + token あり接続) すべて通ることを確認した。
- 高レベル API の `connectMediaPublisher` / `createMediaSubscriber` は内部で Catalog 待ちや MediaStream を要求するため、「接続確立まで」のスコープを保つために低レベル `connect()` を直接使う設計にした。
- ユーザー指摘により Playwright で `getUserMedia` を扱う際の落とし穴を回避するため、本基盤ではメディア取得を一切行わない。
