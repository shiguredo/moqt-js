/**
 * shaka-player の experimental build を public/ へコピーする。
 *
 * 優先順位:
 * 1. SHAKA_DIST が指定されていれば、その dist
 * 2. ローカルの shaka-player checkout の dist
 * 3. リポジトリに同梱した gzip (shaka-player/vendor)
 *
 * 3 は開発環境で shaka-player をビルドしなくてもページを起動できるようにする
 * ためのフォールバックである。CI のデプロイでは SHAKA_DIST を渡し、pinned commit
 * からビルドした成果物を必ず使う。--optional は開発サーバー用で、ビルドが無くても
 * ページ自体は起動させる (画面には shaka が無い旨を出す)。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";

const packageRoot = resolve(import.meta.dirname, "..");
const explicitShakaDist = process.env.SHAKA_DIST;
const localShakaDist = explicitShakaDist ?? "/home/shiguredo/src/shaka-player/dist";
const vendorDir = join(packageRoot, "vendor");
const optional = process.argv.includes("--optional");
const files = ["shaka-player.experimental.js", "shaka-player.transmuxer-worker.js"];

const publicDir = join(packageRoot, "public");
mkdirSync(publicDir, { recursive: true });

const missing = [];
for (const name of files) {
  const localSource = join(localShakaDist, name);
  if (existsSync(localSource)) {
    copyFileSync(localSource, join(publicDir, name));
    console.log(`vendored ${name} from ${localSource}`);
    continue;
  }

  if (explicitShakaDist !== undefined) {
    missing.push(`${name} (SHAKA_DIST=${explicitShakaDist})`);
    continue;
  }

  const fallbackSource = join(vendorDir, `${name}.gz`);
  if (existsSync(fallbackSource)) {
    writeFileSync(join(publicDir, name), gunzipSync(readFileSync(fallbackSource)));
    console.log(`vendored ${name} from committed fallback ${fallbackSource}`);
    continue;
  }

  missing.push(name);
}

if (missing.length > 0) {
  const message =
    `shaka-player build is missing: ${missing.join(", ")}; ` +
    "set SHAKA_DIST to a built shaka-player dist directory";
  if (optional) {
    console.warn(`warning: ${message} (starting without shaka-player)`);
  } else {
    throw new Error(message);
  }
}
