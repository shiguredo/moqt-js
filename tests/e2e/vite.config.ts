import { defineConfig } from "vite-plus";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";

// Playwright E2E 用の最小 Vite アプリ
// playwright.config.ts の webServer から起動される
const packageJson = JSON.parse(readFileSync(resolve(__dirname, "../../package.json"), "utf-8")) as {
  version: string;
};

export default defineConfig({
  server: {
    port: 5180,
    strictPort: true,
  },
  define: {
    // src/version.ts が要求する定数を埋め込む (ルート vite.config.ts と同じ扱い)
    __MOQT_JS_VERSION__: JSON.stringify(packageJson.version),
  },
  resolve: {
    alias: {
      // 開発中はソースを直接参照する
      "moqt-js": resolve(__dirname, "../../src/index.ts"),
    },
  },
});
