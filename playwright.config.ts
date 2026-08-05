import { defineConfig, devices } from "@playwright/test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

// Node 20.12+ の組み込み API で .env を読み込む
// dotenv パッケージへの依存を避ける
const envFile = resolve(import.meta.dirname, ".env");
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

// WebTransport は Chromium 系のみ対応
// pubsub.spec.ts は Catalog 受信 + 5 秒の pub/sub + 後片付けで 10 秒では収まらないため 30 秒に引き上げる
export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: /.*\.spec\.ts$/,
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://localhost:5180",
    ignoreHTTPSErrors: true,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: [
    {
      // moqt-js E2E 用の独立 Vite アプリ
      command: "pnpm --filter moqt-js-e2e dev",
      url: "http://localhost:5180",
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    {
      // webtransport-devtools の UI テスト用
      // ポートは devtools/vite.config.ts の server.port (5173) に固定される
      command: "pnpm --filter moqt-devtools dev",
      url: "http://localhost:5173/webtransport-devtools.html",
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
  ],
});
