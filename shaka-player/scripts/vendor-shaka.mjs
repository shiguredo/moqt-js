/**
 * shaka-player の experimental build を public/ へコピーする。
 *
 * CI では shaka-player を pinned commit からビルドした dist を SHAKA_DIST で渡す。
 * ローカルでは既定の checkout の dist を使う。--optional は開発サーバー用で、
 * ビルドが無くてもページ自体は起動させる (画面には shaka が無い旨を出す)。
 */
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const packageRoot = resolve(import.meta.dirname, "..");
const shakaDist = process.env.SHAKA_DIST ?? "/home/shiguredo/src/shaka-player/dist";
const optional = process.argv.includes("--optional");
const files = ["shaka-player.experimental.js", "shaka-player.transmuxer-worker.js"];

const publicDir = join(packageRoot, "public");
mkdirSync(publicDir, { recursive: true });

const missing = [];
for (const name of files) {
  const source = join(shakaDist, name);
  if (!existsSync(source)) {
    missing.push(name);
    continue;
  }
  copyFileSync(source, join(publicDir, name));
  console.log(`vendored ${name} from ${source}`);
}

if (missing.length > 0) {
  const message =
    `shaka-player build is missing in ${shakaDist}: ${missing.join(", ")}; ` +
    "set SHAKA_DIST to a built shaka-player dist directory";
  if (optional) {
    console.warn(`warning: ${message} (starting without shaka-player)`);
  } else {
    throw new Error(message);
  }
}
