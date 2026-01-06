import { defineConfig } from "vitest/config";
import packageJson from "./package.json";

export default defineConfig({
  define: {
    __MOQT_JS_VERSION__: JSON.stringify(packageJson.version),
  },
  test: {
    include: ["src/**/*.{test,prop}.ts"],
    coverage: {
      provider: "v8",
      exclude: ["src/message/debug.ts"],
    },
  },
});
