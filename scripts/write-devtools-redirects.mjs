/**
 * 旧 /shaka-player/ へのリンクを、devtools の Shaka Player ページへ寄せる。
 *
 * shaka-player は devtools の 1 ページ (shaka-player.html) になったため、
 * 以前の URL で開かれても同じ画面へ移動できるようにする。
 */
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const dist = resolve(import.meta.dirname, "..", "devtools", "dist");
// Cloudflare Pages は shaka-player.html を pretty URL /shaka-player へ 308 で
// 寄せる。ここで /shaka-player を .html へ戻すとループになるため、末尾スラッシュ
// 付きの旧 URL だけを /shaka-player へ寄せる。
const redirects = ["/shaka-player/ /shaka-player 301", ""].join("\n");
writeFileSync(join(dist, "_redirects"), redirects);
console.log(`wrote ${join(dist, "_redirects")}`);
