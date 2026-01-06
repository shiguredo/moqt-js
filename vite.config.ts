import { defineConfig } from "vite";
import { resolve } from "node:path";
import packageJson from "./package.json";

export default defineConfig({
  define: {
    __MOQT_JS_VERSION__: JSON.stringify(packageJson.version),
  },
  build: {
    target: "esnext",
    outDir: "dist",
    lib: {
      entry: resolve(__dirname, "src/index.ts"),
      formats: ["es"],
      fileName: "index",
    },
  },
});
