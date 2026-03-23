import { defineConfig } from "vite-plus";
import { resolve } from "node:path";
import packageJson from "./package.json" with { type: "json" };

export default defineConfig({
  define: {
    __MOQT_JS_VERSION__: JSON.stringify(packageJson.version),
  },
  build: {
    target: "esnext",
    outDir: "dist",
    lib: {
      entry: resolve(import.meta.dirname, "src/index.ts"),
      formats: ["es"],
      fileName: "index",
    },
  },
  fmt: {
    ignorePatterns: ["dist/**", "devtools/dist/**"],
  },
  lint: {
    ignorePatterns: ["dist/**", "devtools/dist/**", "devtools/main.ts"],
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  test: {
    include: ["src/**/*.{test,prop}.ts"],
    coverage: {
      provider: "v8",
      exclude: ["src/message/debug.ts"],
    },
  },
});
