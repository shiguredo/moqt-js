import { defineConfig, type UserConfig } from "vite-plus";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import preact from "@preact/preset-vite";
import tailwindcss from "@tailwindcss/vite";
import packageJson from "../package.json";

/**
 * フッターに出すビルド元を決める。
 *
 * devtools は moqt-js のソースを直接参照するため、package.json の version は
 * 「直近にリリースした版」を指す。develop のビルドでその値を画面に出すと、
 * リリース済みの版を名乗ってしまう。そのためタグのビルドはタグ名、それ以外の
 * ビルドはブランチ名と短縮 SHA にする。
 *
 * GitHub Actions の checkout はタグを取得しない浅い clone で detached HEAD に
 * なるため、git より先に GITHUB_REF_TYPE / GITHUB_REF_NAME / GITHUB_SHA を見る。
 * どちらも取れない場合 (git が無い、アーカイブを展開した等) は version にする。
 */
function resolveBuildLabel(): string {
  const refType = process.env.GITHUB_REF_TYPE;
  const refName = process.env.GITHUB_REF_NAME;
  const commitHash = process.env.GITHUB_SHA;
  if (refType === "tag" && refName !== undefined) {
    return refName;
  }
  if (refType === "branch" && refName !== undefined && commitHash !== undefined) {
    return `${refName} (${commitHash.slice(0, 7)})`;
  }

  // git が無い環境では例外になるため、その場合は空文字にして次の手段へ落とす
  // stderr は握る (タグが無いときの `fatal: no tag exactly matches` を画面に出さない)
  const git = (args: string[]): string => {
    try {
      return execFileSync("git", args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      return "";
    }
  };

  // タグのコミットをビルドしているならタグ名だけで足りる
  const tag = git(["describe", "--tags", "--exact-match"]);
  if (tag !== "") {
    return tag;
  }
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  const shortHash = git(["rev-parse", "--short", "HEAD"]);
  if (branch !== "" && shortHash !== "") {
    return `${branch} (${shortHash})`;
  }
  return packageJson.version;
}

const config: UserConfig = {
  plugins: [...preact(), ...tailwindcss()],
  base: "/",
  // Playwright E2E テストから dev サーバーへ安定してアクセスするためポートを固定する
  server: {
    port: 5173,
    strictPort: true,
  },
  define: {
    // moqt-js ソースを直接参照するため、ビルド時にバージョン定数を注入
    __MOQT_JS_VERSION__: JSON.stringify(packageJson.version),
    // フッターに出すビルド元。リリース済みの版を名乗らないようにする
    __MOQT_DEVTOOLS_BUILD__: JSON.stringify(resolveBuildLabel()),
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
        "c4m-devtools": resolve(__dirname, "c4m-devtools.html"),
      },
    },
  },
};

export default defineConfig(config);
