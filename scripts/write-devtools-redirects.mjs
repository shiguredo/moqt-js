/**
 * 旧 /shaka-player/ へのリンクを、devtools の shaka-player.html へ寄せる。
 *
 * shaka-player は devtools の 1 ページ (shaka-player.html) になったため、
 * 以前の URL で開かれても同じ画面へ移動できるようにする。
 */
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const dist = resolve(import.meta.dirname, "..", "devtools", "dist");
const redirects = [
  "/shaka-player /shaka-player.html 301",
  "/shaka-player/ /shaka-player.html 301",
  "",
].join("\n");
writeFileSync(join(dist, "_redirects"), redirects);
console.log(`wrote ${join(dist, "_redirects")}`);
