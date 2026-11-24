import { defineConfig } from "vite-plus";
import preact from "@preact/preset-vite";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";

// このアプリは Cloudflare Pages の /shaka-player/ 配下で配信する。
// base を固定することで、資産の URL が開発時と本番で一致する。
export default defineConfig({
  base: "/shaka-player/",
  plugins: [preact(), tailwindcss()],
  server: {
    port: 5181,
    strictPort: true,
  },
  build: {
    outDir: "dist",
    rollupOptions: {
      input: resolve(import.meta.dirname, "index.html"),
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
  },
});
