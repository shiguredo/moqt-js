import { defineConfig, type UserConfig } from "vite-plus";
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
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

const SHAKA_PLAYER_PREFIX = "/shaka-player";

const MIME_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

interface DevServerLike {
  middlewares: {
    use(
      handler: (request: IncomingMessage, response: ServerResponse, next: () => void) => void,
    ): void;
  };
}

/**
 * dev サーバーで /shaka-player/ を、ビルド済みの shaka-player アプリから配信する。
 *
 * 別ポートの Vite サーバーを起動せず、devtools と同じ 5173 だけで完結させる。
 * shaka-player の dist は scripts/prepare-shaka-dev.mjs が dev 開始前に作る。
 * shaka-player 自体を編集するときは `vp run dev:shaka` (5181) を使う。
 */
function serveShakaPlayer(): {
  name: string;
  apply: "serve";
  configureServer(server: DevServerLike): void;
} {
  const shakaDist = resolve(import.meta.dirname, "../shaka-player/dist");
  return {
    name: "serve-shaka-player",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const requestUrl = request.url ?? "";
        if (!requestUrl.startsWith(SHAKA_PLAYER_PREFIX)) {
          next();
          return;
        }

        let pathname: string;
        try {
          pathname = decodeURIComponent(requestUrl.split("?")[0] ?? "");
        } catch {
          response.statusCode = 400;
          response.end();
          return;
        }

        if (pathname === SHAKA_PLAYER_PREFIX) {
          response.statusCode = 301;
          response.setHeader("Location", `${SHAKA_PLAYER_PREFIX}/`);
          response.end();
          return;
        }

        let relativePath = pathname.slice(SHAKA_PLAYER_PREFIX.length);
        if (relativePath === "/") {
          relativePath = "/index.html";
        }
        const filePath = normalize(join(shakaDist, relativePath));
        if (!filePath.startsWith(`${shakaDist}${sep}`)) {
          response.statusCode = 403;
          response.end();
          return;
        }

        try {
          if (!statSync(filePath).isFile()) {
            response.statusCode = 404;
            response.end();
            return;
          }
          const body = readFileSync(filePath);
          response.statusCode = 200;
          response.setHeader(
            "Content-Type",
            MIME_TYPES[extname(filePath)] ?? "application/octet-stream",
          );
          response.setHeader("Content-Length", String(body.byteLength));
          response.end(body);
        } catch {
          response.statusCode = 404;
          response.end();
        }
      });
    },
  };
}

const config: UserConfig = {
  // UI の更新コードを SDK の AudioWorklet へ注入しない。Worklet には Vite client が
  // 要求する URL などの Window / Worker 用 API がなく、プロセッサー登録前に失敗する。
  plugins: [
    ...preact({ include: [resolve(__dirname, "src/**/*.{ts,tsx}")] }),
    ...tailwindcss(),
    serveShakaPlayer(),
  ],
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

// /shaka-player は本番では同じオリジンの別アプリだが、開発中は
// shaka-player の Vite サーバー (5181) で動く。devtools の dev サーバーは
// 未知のパスを index.html にフォールバックするため、/shaka-player/ を
// そのままリンクすると devtools の画面のままになってしまう。
// serve のときだけ別オリジンの URL を埋め込む。
export default defineConfig(config);
