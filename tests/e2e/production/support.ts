import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { test, type Page } from "@playwright/test";

/**
 * production ビルド検証 (tests/e2e/production) の共通部分
 *
 * このディレクトリのアプリは moqt-js を src alias ではなく workspace リンクの dist で
 * 解決する (tests/e2e/production/vite.config.ts)。そのため、ここで検査する成果物は
 * 「利用側 Vite の production ビルド + moqt-js の既定 useWorker」が実際に生成した
 * worker の参照そのものである。
 */

/** production 検証用アプリの URL (playwright.config.ts の webServer と一致させる) */
export const PRODUCTION_ORIGIN = "http://localhost:5190";

/** production 検証用アプリのページ URL */
export const PRODUCTION_PAGE_URL = `${PRODUCTION_ORIGIN}/index.html`;

/** ビルド成果物の出力先 (このファイルの隣の dist) */
export const PRODUCTION_OUTPUT_DIR = join(import.meta.dirname, "dist");

/** 接続先が無い環境での skip 理由 (日本語のテストログとして出す) */
export const RELAY_REQUIRED_SKIP_REASON =
  "TEST_MOQT_URI が設定されていないため実リレーへ接続するテストを実行しない";

/**
 * 実リレー接続を伴う production 検証のタイムアウト
 *
 * 接続、PUBLISH の往復、カタログの送信、エンコーダーの configure までを 1 本で待つ。
 */
export const PRODUCTION_RELAY_TIMEOUT_MS = 90_000;

/**
 * 実リレーの MOQT URI を取り出す
 *
 * 未設定の環境ではテストを skip として記録し、null を返す。呼び出し側は null なら
 * 直ちに return する (relay ディレクトリの support と同じ扱い)。
 */
export function requireRelayUri(): string | null {
  const uri = process.env.TEST_MOQT_URI;
  if (uri !== undefined && uri.length > 0) {
    return uri;
  }
  test.skip(true, RELAY_REQUIRED_SKIP_REASON);
  return null;
}

/** production アプリのページを開き、テスト API が公開されるまで待つ */
export async function openProductionPage(page: Page): Promise<void> {
  await page.goto(PRODUCTION_PAGE_URL);
  // 配信元がこのアプリでなければ以降の検査が意味を持たないため、先に確かめる
  await page.waitForFunction(() => Boolean(window.__moqtProduction));
}

/**
 * ビルド済みの worker スクリプトの参照
 *
 * 「参照」はビルドされた JS に書かれている worker の URL であり、data URL の場合と
 * 配信されるファイルの場合がある。どちらも `new Worker(参照, { type: "module" })` へ
 * そのまま渡る値を保持する。
 */
export interface WorkerScriptReference {
  /** 参照を見つけた JS チャンク (出力ディレクトリからの相対パス) */
  readonly chunk: string;
  /** ビルドされた JS に書かれている worker の URL */
  readonly url: string;
  /** worker スクリプトの中身 (data URL は base64 をデコードしたもの) */
  readonly script: string;
  /** worker の種類 (audioEncoder など)。判定できなければ null */
  readonly kind: string | null;
  /** 参照元の JS に加えて出力ディレクトリ内の worker スクリプトも拾ったか */
  readonly referenced: boolean;
}

/** worker スクリプトに含まれる WebCodecs の型から種類を判定する */
const WORKER_KIND_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ["audioEncoder", /new AudioEncoder\(/],
  ["videoEncoder", /new VideoEncoder\(/],
  ["audioDecoder", /new AudioDecoder\(/],
  ["videoDecoder", /new VideoDecoder\(/],
];

/** worker スクリプトの中身から種類を判定する */
function detectWorkerKind(script: string): string | null {
  for (const [kind, pattern] of WORKER_KIND_PATTERNS) {
    if (pattern.test(script)) {
      return kind;
    }
  }
  return null;
}

/**
 * `new URL("<literal>", ...import.meta.url)` の literal を取り出す
 *
 * Vite は worker をインライン化する場合は data URL の literal を、ファイルとして
 * 出力する場合は配信パスの literal をここへ書く。base 側の式は
 * `'' + import.meta.url` や `` ``+import.meta.url `` になるため、import.meta.url を
 * 含むことだけを条件にする。
 */
const NEW_URL_PATTERN = /new URL\(\s*(["'`])([^"'`]+)\1\s*,\s*[^)]*import\.meta\.url[^)]*\)/g;

/** インライン化された worker の data URL */
const WORKER_DATA_URL_PATTERN =
  /data:text\/javascript(?:;charset=[^;,]+)?;base64,([A-Za-z0-9+/=]+)/g;

/** 出力ディレクトリ配下の JS ファイルを列挙する */
async function listJavaScriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listJavaScriptFiles(path)));
      continue;
    }
    if (entry.name.endsWith(".js")) {
      files.push(path);
    }
  }
  return files;
}

/** ファイルを読み、存在しなければ null を返す */
async function readFileIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * ビルド成果物から worker スクリプトの参照を集める
 *
 * 収集は 2 段階にする。
 *
 * 1. ビルドされた JS に書かれた参照 (data URL の literal と `new URL(...)` の literal)
 *    を辿り、参照先が worker スクリプト (self.onmessage を持つ) なら採用する
 * 2. 参照されていない worker スクリプトが出力ディレクトリに残っていれば併せて採用する
 *    (将来 Vite の出力形式が変わって参照の書き方が変わっても、成果物の検査を落とさない)
 *
 * spec は 1 を「利用側のビルドが実際に渡す参照」、2 を含む全体を「ビルドが出力した
 * worker スクリプト」として検査する。
 */
export async function collectWorkerScriptReferences(
  outputDirectory: string = PRODUCTION_OUTPUT_DIR,
): Promise<WorkerScriptReference[]> {
  const files = await listJavaScriptFiles(outputDirectory);
  const references: WorkerScriptReference[] = [];
  const seenScripts = new Set<string>();

  const push = (chunk: string, url: string, script: string, referenced: boolean): void => {
    if (!script.includes("self.onmessage") || seenScripts.has(script)) {
      return;
    }
    seenScripts.add(script);
    references.push({
      chunk,
      url,
      script,
      kind: detectWorkerKind(script),
      referenced,
    });
  };

  for (const file of files) {
    const text = await readFile(file, "utf8");
    const chunk = relative(outputDirectory, file);

    // インライン化された worker (data URL の literal)
    for (const match of text.matchAll(WORKER_DATA_URL_PATTERN)) {
      const encoded = match[1];
      if (encoded === undefined) {
        continue;
      }
      push(chunk, match[0], Buffer.from(encoded, "base64").toString("utf8"), true);
    }

    // ファイルとして出力された worker (new URL の literal)
    for (const match of text.matchAll(NEW_URL_PATTERN)) {
      const literal = match[2];
      if (literal === undefined || literal.startsWith("data:")) {
        continue;
      }
      const path = literal.startsWith("/")
        ? join(outputDirectory, literal)
        : resolve(dirname(file), literal);
      const script = await readFileIfExists(path);
      if (script !== null) {
        push(chunk, literal, script, true);
      }
    }
  }

  // 参照されていない worker スクリプト (上の走査で拾えなかったもの)。
  // この場合はスクリプト自身の配信パスを URL として扱う (配信ルートからの絶対パス)
  for (const file of files) {
    const script = await readFile(file, "utf8");
    const relativePath = relative(outputDirectory, file);
    push(relativePath, `/${relativePath}`, script, false);
  }

  return references;
}

/**
 * worker スクリプトが自己完結していない箇所を列挙する
 *
 * `new Worker(url, { type: "module" })` へ渡るスクリプトは、その URL を基準に
 * モジュールを解決できる保証が無い。data URL は階層を持たず相対解決が例外になり、
 * 配信パスは配信構成 (ベースパス・別ホストへの配置) に依存する。そのため
 * 自己完結 = モジュール解決を一切要求しないこと、と定義して検査する。
 *
 * import.meta.url の参照自体は違反にしない (自己完結したスクリプトでも自分の位置を
 * 知るために使える)。違反にするのは、それを基準に相対 URL を解決している箇所だけである。
 * ここでの違反は「今の worker が実際に壊れる」ことの証明ではなく、
 * 「参照先がどこへ配信されても動く」ための条件である。
 */
export function findSelfContainmentViolations(script: string): string[] {
  const violations: string[] = [];

  // static import は minify されると空白が消える (`import{x}from"..."`) ため、
  // `import` と指定子の間の空白を必須にしない。`import.meta.url` は `import` の直後が
  // `.` であり、下のどちらの形にも一致しない
  // (import "x" / import x from "x" / import{x}from"x" / import * as x from "x")
  for (const match of script.matchAll(
    /(?:^|[\s;{}()])import\s*(?:["'][^"']+["']|[\w$*{},\s]*?from\s*["'][^"']+["'])/g,
  )) {
    violations.push(`静的 import がある: ${match[0].trim()}`);
  }

  // re-export もモジュール解決を要求する
  // (export * from "x" / export { x } from "x" / minify 後の export{x}from"x")
  for (const match of script.matchAll(
    /(?:^|[\s;{}()])export\s*(?:\*|\{[^}]*\})\s*from\s*["'][^"']+["']/g,
  )) {
    violations.push(`re-export がある: ${match[0].trim()}`);
  }

  // 動的 import (import("..."))
  for (const match of script.matchAll(/(?:^|[^\w$.])import\s*\(\s*["'`]([^"'`]+)["'`]/g)) {
    violations.push(`動的 import がある: ${match[1]}`);
  }

  // import.meta.url を基準にした相対 URL の解決 (new URL("./x", import.meta.url))。
  // 参照先が data URL としてインライン化されると解決できない
  const relativeUrls = script.matchAll(
    /new URL\(\s*["'`](\.[^"'`]*)["'`]\s*,\s*[^)]*import\.meta\.url/g,
  );
  for (const match of relativeUrls) {
    violations.push(`import.meta.url 基準の相対 URL がある: ${match[1]}`);
  }

  return violations;
}

/**
 * worker の種類ごとに init へ渡す設定
 *
 * 実リレーを必要としない範囲で configure まで到達させるため、Chromium が
 * ソフトウェアで扱えるコーデック (VP8 / Opus) を指定する。
 */
export function initConfigForKind(kind: string | null): unknown {
  switch (kind) {
    case "videoEncoder":
      return { codec: "vp8", width: 320, height: 240, bitrate: 500_000, framerate: 30 };
    case "audioEncoder":
      return { codec: "opus", sampleRate: 48_000, numberOfChannels: 2, bitrate: 64_000 };
    case "videoDecoder":
      return { codec: "vp8", codedWidth: 320, codedHeight: 240 };
    case "audioDecoder":
      return { codec: "opus", sampleRate: 48_000, numberOfChannels: 2 };
    default:
      return {};
  }
}

/**
 * worker スクリプトの中身から data URL を作る
 *
 * 利用者の assetsInlineLimit が worker のサイズより大きい場合、Vite は worker を
 * data URL としてインライン化する。配信された成果物と同じバイト列でその経路を
 * 起動できることを確かめるために使う (実装を差し替えるスタブではない)。
 */
export function toWorkerDataUrl(script: string): string {
  return `data:text/javascript;charset=utf-8,${encodeURIComponent(script)}`;
}
