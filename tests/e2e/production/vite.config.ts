import { defineConfig, type Plugin } from "vite-plus";

/**
 * moqt-js が src ではなく dist へ解決されていることをビルド時に確かめるプラグイン
 *
 * この検証用アプリの目的は「利用側 Vite の production ビルドが moqt-js の dist を
 * 消費したときに worker が起動するか」を再現することにある。src へ alias を張ると
 * アプリ側の Vite が src を直接バンドルしてしまい (worker もアプリ側の Vite が
 * 自己完結した形で出力する)、dist の worker 参照が壊れていてもテストが green になる。
 * その取り違えを、設定の書き忘れではなくビルドの失敗として検出する。
 *
 * 解決の検査は alias を含む解決パイプライン全体を通した結果で行う
 * (`this.resolve` に `skipSelf` を渡すため、alias が張られていればその結果が返る)。
 */
function assertMoqtJsResolvesToDist(): Plugin {
  return {
    name: "moqt-js-consume-dist",
    async resolveId(source, importer, options) {
      if (source !== "moqt-js") {
        return null;
      }
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      if (resolved === null) {
        throw new Error("production 検証アプリで moqt-js を解決できなかった");
      }
      // クエリ (例: ?worker) を除いた実ファイルで判定する
      const id = resolved.id.split("?")[0] ?? resolved.id;
      if (!id.endsWith("/dist/index.js")) {
        throw new Error(
          `production 検証アプリの moqt-js が dist/index.js ではなく ${resolved.id} へ解決された。` +
            "src alias を張ると production ビルドの問題を再現できず、テストが偽の green になる",
        );
      }
      // 解決そのものは Vite に任せる (このプラグインは検査だけを行う)
      return null;
    },
  };
}

// 利用側 Vite の production ビルドで moqt-js の dist を消費する最小アプリ
//
// tests/e2e/vite.config.ts は `moqt-js` を src/index.ts へ alias しているため dev サーバー
// 上のテストでは dist の壊れ方を再現できない。このアプリは alias を張らず、
// tests/e2e/node_modules の workspace リンク (moqt-js -> リポジトリルート) 経由で
// ルート package.json の exports が指す dist/index.js を解決させる。
//
// build.assetsInlineLimit は既定値 (4096) のまま使う。利用者が既定設定で production
// ビルドしたときに起きる挙動を再現することがこのアプリの目的である。
export default defineConfig({
  plugins: [assertMoqtJsResolvesToDist()],
  server: {
    // playwright.config.ts の webServer.url と一致させる。
    // 既存の dev サーバー (devtools の 5173、tests/e2e の 5180) とは別のポートを使う
    port: 5190,
    strictPort: true,
  },
  preview: {
    // playwright.config.ts の webServer.url と一致させる
    port: 5190,
    strictPort: true,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
