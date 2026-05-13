import { defineConfig } from "vite-plus";
import { resolve } from "node:path";

export default defineConfig({
  server: {
    port: 5174,
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
