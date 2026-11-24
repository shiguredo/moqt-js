/**
 * devtools の dev サーバーで /shaka-player/ を配信する前に、
 * shaka-player アプリを 1 回ビルドしておく。
 *
 * shaka-player の dist を devtools の Vite dev サーバーが静的配信するため、
 * 別ポートの dev サーバーは起動しない。shaka-player 自体を編集するときは
 * `vp run dev:shaka` を使う。
 */
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");

const run = (command, args) => {
  execFileSync(command, args, {
    cwd: repositoryRoot,
    stdio: "inherit",
  });
};

// shaka-player の experimental build が無い場合でも、ページ自体は起動できるよう
// vendor は optional にする。
run(process.execPath, ["shaka-player/scripts/vendor-shaka.mjs", "--optional"]);
run("vp", ["build", "shaka-player"]);
