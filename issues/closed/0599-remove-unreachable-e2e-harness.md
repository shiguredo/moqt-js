# 到達不能な e2e ハーネスと plan 外のテストスクリプトを削除する

- Created: 2026-09-13
- Completed: 2026-09-14
- Branch: feature/remove-unreachable-e2e-harness
- Polished: {YYYY-MM-DD}

## 目的

CI の e2e job は `TEST_MOQT_URI` / `TEST_MOQT_AUTH_TOKEN` を secrets から注入し、Playwright を chromium 付きで install して `vp run e2e-test` を実行しているが、実際に走るのは `tests/e2e/webtransport-devtools.spec.ts` の 3 テスト (WebTransport サーバー不要の UI テスト) だけである。

MOQT サーバーへ実際に接続する spec 2 本が `test.describe.skip` で無条件にスキップされており、その 2 本だけが使うハーネス (`tests/e2e/main.ts` の `window.__moqtE2E` と `tests/e2e/helpers.ts`) は実行時に 1 度も呼ばれない。テストとして機能していないコードと、そのために必要な secrets 注入・ブラウザ install が残り続けている。

到達しないコードを削除し、CI の e2e job が実際に検証している内容と一致する状態にする。

## 現状

- `tests/e2e/connect.spec.ts` は `test.describe.skip("MOQT Session connection", ...)` で全体がスキップされている。内側の `test.skip(!MOQT_URI, ...)` は到達不能な二重ガード。
- `tests/e2e/pubsub.spec.ts` は `test.describe.skip("MOQT Canvas pub/sub", ...)` で全体がスキップされている。同じく内側の `test.skip` は到達不能。
- `window.__moqtE2E` を参照するのは上記 2 spec と `tests/e2e/main.ts` / `tests/e2e/helpers.ts` のみである。`tests/e2e/webtransport-devtools.spec.ts` は参照しない。
- `.github/workflows/ci.yml` の e2e job は `TEST_MOQT_URI` / `TEST_MOQT_AUTH_TOKEN` を env で渡し、`vp exec playwright install --with-deps chromium` を実行する。
- `package.json` の `e2e-test-chrome` / `e2e-test-edge` / `e2e-test-webkit` は `playwright.config.ts` に存在しない project 名 (`Google Chrome*` / `Microsoft Edge*` / `WebKit`) を指定しており、実行すれば失敗する。`playwright.config.ts` の `projects` は `chromium` の 1 件のみ。
- `tests/e2e/index.html` は `window.__moqtE2E` を定義する `tests/e2e/main.ts` のエントリページである。

## 設計方針

削除を選ぶ。MOQT サーバーへ接続する e2e を復活させる判断は、接続先を CI で安定して用意できるようになった時点で別途行う。スキップされたままの spec とその専用ハーネスを残すことは、テストがあるように見えて実際には何も検証していない状態を固定してしまう。

1. `tests/e2e/connect.spec.ts` と `tests/e2e/pubsub.spec.ts` を削除する。
2. `tests/e2e/main.ts` / `tests/e2e/index.html` / `tests/e2e/helpers.ts` を削除する。`tests/e2e/vite.config.ts` は `webtransport-devtools.spec.ts` が使う dev サーバーの起動に必要かどうかを確認し、不要なら合わせて削除する。
3. `playwright.config.ts` から不要になった `webServer` エントリと、`tests/e2e` 用の設定を整理する。`webtransport-devtools.spec.ts` の実行に必要な設定は残す。
4. `.github/workflows/ci.yml` の e2e job から `TEST_MOQT_URI` / `TEST_MOQT_AUTH_TOKEN` の env を削除する。
5. `package.json` から存在しない project を指定している `e2e-test-chrome` / `e2e-test-edge` / `e2e-test-webkit` を削除する。
6. 削除後も `vp run e2e-test` が通り、`webtransport-devtools.spec.ts` の 3 テストが実行されることを確認する。

## 完了条件

- `tests/e2e/` にスキップされた spec と、それ専用のハーネスが残っていないこと。
- `vp run e2e-test` が通り、実行されたテスト件数が削除前と同じ 3 件であること。
- `.github/workflows/ci.yml` の e2e job に不要な secrets の注入が残っていないこと。
- `package.json` に存在しない Playwright project を指定する script が残っていないこと。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。
- `CHANGES.md` の `## develop` に該当する変更種別のエントリを追加すること。

## 参照

- `tests/e2e/connect.spec.ts` / `tests/e2e/pubsub.spec.ts` (`test.describe.skip`)
- `tests/e2e/main.ts` (`window.__moqtE2E`) / `tests/e2e/helpers.ts` (`waitForE2EReady`) / `tests/e2e/index.html`
- `tests/e2e/webtransport-devtools.spec.ts` (削除後も残す唯一の spec)
- `playwright.config.ts` (`projects` / `webServer`)
- `.github/workflows/ci.yml` (e2e job)
- `package.json` (`e2e-test-chrome` / `e2e-test-edge` / `e2e-test-webkit`)

## 解決方法

削除した。MOQT サーバーへ接続する e2e を復活させる判断は、接続先を CI で安定して用意できるようになった時点で別途行う。

### 削除したファイル

- `tests/e2e/connect.spec.ts` / `tests/e2e/pubsub.spec.ts` (`test.describe.skip` で無条件スキップ)
- `tests/e2e/main.ts` (`window.__moqtE2E`) / `tests/e2e/helpers.ts` (`waitForE2EReady`) / `tests/e2e/index.html`
- `tests/e2e/vite.config.ts` / `tests/e2e/package.json` / `tests/e2e/tsconfig.json`

`tests/e2e/vite.config.ts` は moqt-js-e2e 専用 Vite アプリの設定であり、`webtransport-devtools.spec.ts` が使う devtools dev サーバー (`pnpm --filter moqt-devtools dev`) には不要である。3 ファイルを削除すると `moqt-js-e2e` ワークスペースは何も提供しなくなるため、`pnpm-workspace.yaml` の `packages` から `tests/e2e` を外した (`pnpm-lock.yaml` の importer も消える)。`@playwright/test` はルートの devDependency であり、削除の影響はない。

削除後 `tests/e2e/` に残るのは `webtransport-devtools.spec.ts` のみである。

### 設定の整理

- `playwright.config.ts`: moqt-js-e2e の `webServer` エントリを削除し、`pubsub.spec.ts` を前提にした timeout のコメントを実態に合わせた。残る spec は絶対 URL で devtools を開くため `baseURL` を使わないが、`http://localhost:5180` は削除したアプリのポートなので devtools dev サーバーの `http://localhost:5173` に直した
- `playwright.config.ts`: `process.loadEnvFile(".env")` のブロックを削除した。読み込んでいた `TEST_MOQT_URI` / `TEST_MOQT_AUTH_TOKEN` を参照する spec が無くなったためである
- `.env.example`: 上記 2 変数のテンプレートであり、参照先が消えたため削除した
- `.github/workflows/ci.yml`: e2e job から `TEST_MOQT_URI` / `TEST_MOQT_AUTH_TOKEN` の env を削除した
- `package.json`: 存在しない Playwright project (`Google Chrome*` / `Microsoft Edge*` / `WebKit`) を指定していた `e2e-test-chrome` / `e2e-test-edge` / `e2e-test-webkit` を削除した。`playwright.config.ts` の `projects` は `chromium` の 1 件のみである

### 検証

- `vp run e2e-test` を実行し、3 テスト (`webtransport-devtools.spec.ts`) が全通過することを確認した (削除前と同数)
- `vp check` / `tsc --noEmit` 通過
- `vp test run`: 70 ファイル / 2,130 テスト全通過
- `rg "TEST_MOQT|__moqtE2E|waitForE2EReady|moqt-js-e2e"` の一致が issue ファイルと過去の `CHANGES.md` のみであること
- `CHANGES.md` の `## develop` の `### misc` に `[CHANGE]` を追加した (到達不能な e2e を削除する後方互換のない変更のため)

### 補足

ローカルで e2e を実行するには Playwright の chromium 1243 が必要である。本作業では `PLAYWRIGHT_BROWSERS_PATH` を一時ディレクトリに向けて install し、リポジトリ内には残していない。CI は従来どおり `vp exec playwright install --with-deps chromium` で導入する。
