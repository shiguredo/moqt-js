import { defineConfig } from "vite-plus";
import { resolve } from "node:path";
import packageJson from "../package.json";

export default defineConfig({
  server: {
    port: 5174,
  },
  define: {
    // moqt-js ソースを直接参照するため、src/version.ts が参照するバージョン定数を注入する
    // (無いとモジュールの評価が ReferenceError で止まる)
    __MOQT_JS_VERSION__: JSON.stringify(packageJson.version),
  },
  resolve: {
    alias: {
      // 開発中はソースを直接参照
      "moqt-js": resolve(__dirname, "../src/index.ts"),
    },
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        "high-level-api": resolve(__dirname, "high-level-api/index.html"),
      },
    },
  },
});
