import { defineConfig } from "vite-plus";
import { resolve } from "node:path";
import preact from "@preact/preset-vite";
import tailwindcss from "@tailwindcss/vite";
import packageJson from "../package.json";

export default defineConfig({
  plugins: [preact(), tailwindcss()],
  base: "/",
  define: {
    // moqt-js ソースを直接参照するため、ビルド時にバージョン定数を注入
    __MOQT_JS_VERSION__: JSON.stringify(packageJson.version),
  },
  resolve: {
    alias: {
      // 開発中はソースを直接参照
      "moqt-js": resolve(__dirname, "../src/index.ts"),
    },
  },
  optimizeDeps: {
    // alias でソースを直接参照するため、依存スキャンから除外
    exclude: ["moqt-js"],
  },
  build: {
    outDir: "dist",
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        "webtransport-devtools": resolve(__dirname, "webtransport-devtools.html"),
        "webcodecs-devtools": resolve(__dirname, "webcodecs-devtools.html"),
      },
    },
  },
});
