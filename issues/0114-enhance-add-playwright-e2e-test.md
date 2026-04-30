# Playwright による WebTransport 接続 E2E テストを追加する

Created: 2026-04-29
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
