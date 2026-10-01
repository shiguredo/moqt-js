import { existsSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";

// ローカル実行用に .env を読む。
// CI では GitHub Actions の secret が環境変数として渡され .env は存在しないため、
// 存在する場合だけ読む (process.loadEnvFile はファイルが無いと例外になる)。
// 読み込みは既に設定済みの環境変数を上書きしないため、CI の値が優先される。
if (existsSync(".env")) {
  process.loadEnvFile(".env");
}

// 実リレーへ接続する spec は tests/e2e/relay/ に置く。
// 実リレーを必要としない devtools の UI テストとは要求が異なるため project を分け、
// 接続先を渡していない実行で意図せず実リレーへ接続しないようにする。
// 接続先は環境変数 TEST_MOQT_URI で渡し、未設定なら spec 側が skip する。
const RELAY_SPEC_PATTERN = /relay\/.*\.spec\.ts$/;

// WebTransport は Chromium 系のみ対応
export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: /.*\.spec\.ts$/,
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://localhost:5173",
    ignoreHTTPSErrors: true,
    trace: "retain-on-failure",
  },
  projects: [
    {
      // 実リレーを必要としないテスト (devtools の UI、codec wrapper)
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      testIgnore: RELAY_SPEC_PATTERN,
    },
    {
      // 実リレーへ接続するテスト (TEST_MOQT_URI が設定された環境でだけ実行される)
      name: "relay",
      use: { ...devices["Desktop Chrome"] },
      testMatch: RELAY_SPEC_PATTERN,
    },
  ],
  webServer: [
    {
      // devtools の UI テスト用
      // ポートは devtools/vite.config.ts の server.port (5173) に固定される
      command: "pnpm --filter moqt-devtools dev",
      url: "http://localhost:5173/webtransport-devtools.html",
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    {
      // 実リレー接続用のテストページ
      // ポートは tests/e2e/vite.config.ts の server.port (5180) に固定される
      command: "pnpm --filter moqt-js-e2e dev",
      url: "http://localhost:5180/index.html",
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
  ],
});
