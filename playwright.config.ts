import { defineConfig, devices } from "@playwright/test";

// WebTransport は Chromium 系のみ対応
// 残る webtransport-devtools.spec.ts は WebTransport サーバー不要の UI テストである
export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: /.*\.spec\.ts$/,
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    // webtransport-devtools.spec.ts は絶対 URL で devtools を開くため、
    // baseURL は devtools dev サーバーの待ち受けポートに合わせる
    baseURL: "http://localhost:5173",
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
      // webtransport-devtools の UI テスト用
      // ポートは devtools/vite.config.ts の server.port (5173) に固定される
      command: "pnpm --filter moqt-devtools dev",
      url: "http://localhost:5173/webtransport-devtools.html",
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
  ],
});
