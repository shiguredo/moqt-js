import { resolve } from "node:path";
import { defineConfig } from "vite-plus";
import packageJson from "../../package.json";

// このファイルの位置を基準にパスを解決する (設定ファイルは ESM として読み込まれる)
const configDirectory = import.meta.dirname;

// 実リレーへ接続する E2E テスト用の最小 Vite アプリ
// playwright.config.ts の webServer から起動される
export default defineConfig({
  server: {
    // playwright.config.ts の webServer.url と一致させる
    port: 5180,
    strictPort: true,
  },
  define: {
    // src/version.ts が要求する定数を埋め込む (ルート vite.config.ts と同じ扱い)
    __MOQT_JS_VERSION__: JSON.stringify(packageJson.version),
  },
  resolve: {
    alias: {
      // テスト対象はソースそのものなので、ビルド成果物ではなく src を直接参照する
      "moqt-js": resolve(configDirectory, "../../src/index.ts"),
    },
  },
});
