import { defineConfig, devices } from "@playwright/test";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Node 20.12+ の組み込み API で .env を読み込む
// dotenv パッケージへの依存を避ける
const here = dirname(fileURLToPath(import.meta.url));
const envFile = resolve(here, ".env");
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

// WebTransport は Chromium 系のみ対応
// CLAUDE.md のデバッグ timeout 制約に揃えて 10 秒
export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: /.*\.spec\.ts$/,
  timeout: 10_000,
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
  webServer: {
    command: "pnpm --filter moqt-js-e2e dev",
    url: "http://localhost:5180",
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
