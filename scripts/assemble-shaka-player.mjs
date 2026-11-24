/**
 * shaka-player アプリのビルド成果物を、Cloudflare Pages にデプロイする
 * devtools/dist 配下の /shaka-player/ へ配置する。
 *
 * アプリ側の base は /shaka-player/ に固定してあるため、dist の中身を
 * devtools/dist/shaka-player/ にそのまま置けば URL が一致する。
 */
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const source = join(repositoryRoot, "shaka-player", "dist");
const target = join(repositoryRoot, "devtools", "dist", "shaka-player");

if (!existsSync(join(source, "index.html"))) {
  throw new Error(`shaka-player build is missing: ${source}/index.html; run build:shaka first`);
}

rmSync(target, { recursive: true, force: true });
cpSync(source, target, { recursive: true });

// /shaka-player (末尾スラッシュ無し) を /shaka-player/ へ寄せる。
// Cloudflare Pages は未知のパスをルートの index.html へフォールバックするため、
// このリダイレクトが無いと /shaka-player が devtools の画面になってしまう。
const redirectsPath = join(repositoryRoot, "devtools", "dist", "_redirects");
const redirectRule = "/shaka-player /shaka-player/ 301";
const currentRedirects = existsSync(redirectsPath) ? readFileSync(redirectsPath, "utf8") : "";
const redirectLines = currentRedirects
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line !== "");
if (!redirectLines.includes(redirectRule)) {
  const prefix =
    currentRedirects === "" || currentRedirects.endsWith("\n")
      ? currentRedirects
      : `${currentRedirects}\n`;
  writeFileSync(redirectsPath, `${prefix}${redirectRule}\n`);
}

console.log(`assembled ${target}`);
console.log(`updated ${redirectsPath}`);
