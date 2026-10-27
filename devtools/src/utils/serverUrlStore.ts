/**
 * 接続先 (MOQT URI) の候補一覧と、その保存
 *
 * 接続先として登録した MOQT URI を、このオリジンの OPFS に JSON で残す。有効
 * (enabled) な候補が 1 つ以上あるとき、接続のたびにその中から 1 つを選んで使う。
 *
 * 保存形式は `{ "urlEntries": [{ "url": "moqt://...", "enabled": true }] }`。
 * 以前の版が残した 1 行の MOQT URI ファイル (`server-url.txt`) は、読み込み時に
 * 候補 1 件として移行する。
 */

import { assertMsfConnectionSupported, parseMsfFragmentValue } from "../../../src/msf/fragment.ts";
import { resolveMsfAuthorizationToken } from "../../../src/msf/c4mAuthorization.ts";
import { validateTrackNamespaceForSend } from "../../../src/session/params.ts";
import { normalizeMoqtUri } from "../../../src/moqtUri.ts";

/** 登録した接続先の候補 */
export interface ServerUrlEntry {
  /** 接続に使う MOQT URI (fragment を含む) */
  readonly url: string;
  /** 接続の候補として使うかどうか */
  readonly enabled: boolean;
}

/** 新しい候補を登録できるかどうかの判定結果 */
export type ServerUrlValidation =
  | { readonly kind: "ok"; readonly url: string }
  | { readonly kind: "error"; readonly message: string };

/**
 * MOQT URI が接続に使えるかを確かめる
 *
 * `connect()` が URL から決める検証のうち、MOQT URI だけで決まるもの (スキームと
 * fragment の形、msf fragment の解析、`connection=q` の拒否、c4m の Base64 復号、
 * msf fragment の Track Namespace の送信検証) を、接続時と同じライブラリの関数で
 * 確かめる。ここを通らない URI は、ランダムに選ばれても必ず接続に失敗するため、登録や
 * 保存の時点で受け付けない。接続先の検証規則を devtools 側へ写すと、ライブラリの規則と
 * ずれる。
 *
 * @param input - 確かめる MOQT URI (前後の空白は捨てる)
 * @returns 接続に使えるときは null、使えないときは英語の理由
 */
export function validateConnectableServerUrl(input: string): string | null {
  const url = input.trim();
  if (url === "") {
    return "MOQT URI must not be empty";
  }
  let normalized: ReturnType<typeof normalizeMoqtUri>;
  try {
    normalized = normalizeMoqtUri(url);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  try {
    // msf fragment の解析と connection=q の拒否 (draft-ietf-moq-msf-01 §11.1.1)
    assertMsfConnectionSupported(normalized.fragment);
    // c4m の Base64 復号 (draft-ietf-moq-msf-01 §11.1.1 / §11.4.3)
    resolveMsfAuthorizationToken(normalized.fragment);
    // msf fragment の namespace は接続時に validateTrackNamespaceForSend で検証される。
    // 予約 namespace などを登録させない (ランダムに選ばれるたびに接続が失敗するため)
    if (normalized.fragment?.type === "msf") {
      const msf = parseMsfFragmentValue(normalized.fragment.value);
      validateTrackNamespaceForSend(msf.trackNamespace);
    }
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return null;
}

/**
 * 入力した MOQT URI を新しい候補として登録できるか確かめる
 *
 * 前後の空白は捨てる。接続に使えるかは `validateConnectableServerUrl` に確かめさせる
 * (登録した候補は接続のたびにランダムに選ばれるため、接続で必ず失敗する URI を
 * 登録させない)。登録済みの URI と同じ文字列は重複として拒否する。
 *
 * @param entries - 登録済みの候補一覧
 * @param input - 登録したい MOQT URI (画面の入力値)
 * @returns 登録できるときは `{ kind: "ok", url }`、できないときは英語の理由
 */
export function validateNewServerUrl(
  entries: readonly ServerUrlEntry[],
  input: string,
): ServerUrlValidation {
  const url = input.trim();
  const problem = validateConnectableServerUrl(url);
  if (problem !== null) {
    return { kind: "error", message: problem };
  }
  if (entries.some((entry) => entry.url === url)) {
    return { kind: "error", message: `this MOQT URI is already registered: ${url}` };
  }
  return { kind: "ok", url };
}

/**
 * 候補を 1 件追加する
 *
 * 追加した候補は接続に使う (enabled: true) 状態にする。登録順に並べ、同じ URI を
 * 2 つ登録しないことは `validateNewServerUrl` が確かめる。
 */
export function addServerUrlEntry(
  entries: readonly ServerUrlEntry[],
  url: string,
): ServerUrlEntry[] {
  return [...entries, { url, enabled: true }];
}

/** 指定した位置の候補を取り除く (位置が範囲外なら何もしない) */
export function removeServerUrlEntry(
  entries: readonly ServerUrlEntry[],
  index: number,
): ServerUrlEntry[] {
  return entries.filter((_, entryIndex) => entryIndex !== index);
}

/**
 * 指定した位置の候補の有効・無効を設定する (位置が範囲外なら何もしない)
 *
 * 無効にしても一覧には残す。接続の候補から外すだけで、登録そのものは消さない。
 */
export function setServerUrlEntryEnabled(
  entries: readonly ServerUrlEntry[],
  index: number,
  enabled: boolean,
): ServerUrlEntry[] {
  return entries.map((entry, entryIndex) =>
    entryIndex === index ? { url: entry.url, enabled } : entry,
  );
}

/** 接続に使う候補 (enabled なもの) の MOQT URI を登録順に返す */
export function enabledServerUrlUrls(entries: readonly ServerUrlEntry[]): string[] {
  return entries.filter((entry) => entry.enabled).map((entry) => entry.url);
}

/**
 * 有効な候補から 1 つを選ぶ
 *
 * `randomInt` は 0 以上 2^32 未満の整数 (`crypto.getRandomValues` が返す 32 bit)。
 * 剰余の偏りは接続先の選択では問題にしない。候補が無いときは null を返す。
 */
export function pickServerUrlCandidate(urls: readonly string[], randomInt: number): string | null {
  if (urls.length === 0) {
    return null;
  }
  const index = Math.abs(Math.trunc(randomInt)) % urls.length;
  return urls[index] ?? null;
}

/**
 * 保存した JSON を候補一覧にする
 *
 * `JSON.parse` の戻り値は任意の形を取り得るため、実行時に構造を確かめる。構造が壊れて
 * いる項目があれば全体を空にする。構造が正しくても接続に使えない MOQT URI の項目は捨てる
 * (手で壊した保存内容や古い形式の値で、接続のたびに失敗しないようにする)。同じ URI が
 * 並んでいるときは 1 つにまとめる。
 */
export function parseServerUrlEntries(text: string): ServerUrlEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null || !("urlEntries" in parsed)) {
    return [];
  }
  const urlEntries: unknown = parsed.urlEntries;
  if (!Array.isArray(urlEntries) || !urlEntries.every((entry) => isServerUrlEntry(entry))) {
    return [];
  }
  const entries: ServerUrlEntry[] = [];
  const seen = new Set<string>();
  for (const entry of urlEntries) {
    const url = entry.url.trim();
    if (seen.has(url) || validateConnectableServerUrl(url) !== null) {
      continue;
    }
    seen.add(url);
    entries.push({ url, enabled: entry.enabled });
  }
  return entries;
}

/** 候補一覧を保存する JSON にする */
export function formatServerUrlEntries(entries: readonly ServerUrlEntry[]): string {
  return JSON.stringify({
    urlEntries: entries.map((entry) => ({ url: entry.url, enabled: entry.enabled })),
  });
}

/** 候補の構造 ({ url: string, enabled: boolean }) を実行時に検証する型ガード */
function isServerUrlEntry(value: unknown): value is ServerUrlEntry {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate: { url?: unknown; enabled?: unknown } = value;
  return (
    typeof candidate.url === "string" &&
    candidate.url !== "" &&
    typeof candidate.enabled === "boolean"
  );
}

/**
 * 旧形式 (`server-url.txt`) の内容を候補 1 件にする
 *
 * 旧形式は 1 行の MOQT URI だけを覚えていた。空白だけ、改行を含む内容、接続に使えない
 * MOQT URI は、覚えていないものとして null を返す。
 */
export function legacyServerUrlEntry(raw: string): ServerUrlEntry | null {
  const text = raw.trim();
  if (text === "" || text.includes("\n") || text.includes("\r")) {
    return null;
  }
  if (validateConnectableServerUrl(text) !== null) {
    return null;
  }
  return { url: text, enabled: true };
}

/**
 * URL クエリ `urlCandidates` の値 (JSON の文字列配列) を候補一覧にする
 *
 * Copy URL が載せる形式。配列の要素は接続に使う MOQT URI で、すべて有効な候補として
 * 扱う。読めない値、接続に使えない要素、空文字を含む値のときは null を返し、呼び出し側は
 * 候補を変えない。同じ URI が並んでいるときは 1 つにまとめる。
 */
export function parseServerUrlCandidatesParam(raw: string): ServerUrlEntry[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) {
    return null;
  }
  const urls: string[] = [];
  for (const value of parsed) {
    if (typeof value !== "string") {
      return null;
    }
    const url = value.trim();
    if (validateConnectableServerUrl(url) !== null) {
      return null;
    }
    urls.push(url);
  }
  return [...new Set(urls)].map((url) => ({ url, enabled: true }));
}

/**
 * 有効な候補を Copy URL が載せる JSON の文字列配列にする
 *
 * 有効な候補が無いときは null (クエリに載せない)。
 */
export function formatServerUrlCandidatesParam(entries: readonly ServerUrlEntry[]): string | null {
  const urls = enabledServerUrlUrls(entries);
  if (urls.length === 0) {
    return null;
  }
  return JSON.stringify(urls);
}

/** 候補一覧を保存する OPFS のファイル名 */
const SERVER_URLS_FILE = "server-urls.json";
/** 以前の版が 1 行の MOQT URI を保存していた OPFS のファイル名 (移行元) */
const LEGACY_SERVER_URL_FILE = "server-url.txt";

async function privateDirectory(): Promise<FileSystemDirectoryHandle | null> {
  try {
    if (typeof navigator === "undefined" || navigator.storage?.getDirectory === undefined) {
      return null;
    }
    return await navigator.storage.getDirectory();
  } catch {
    return null;
  }
}

/** OPFS のファイルを読む。ファイルが無い / 読めないときは null */
async function readTextFile(
  directory: FileSystemDirectoryHandle,
  fileName: string,
): Promise<string | null> {
  try {
    const handle = await directory.getFileHandle(fileName);
    const file = await handle.getFile();
    return await file.text();
  } catch {
    return null;
  }
}

/** OPFS のファイルを消す (移行時など、消せなくても処理を続けるときに使う) */
async function removeFileIfExists(
  directory: FileSystemDirectoryHandle,
  fileName: string,
): Promise<void> {
  await removeFile(directory, fileName);
}

/** ファイルが無いことを表すエラーかどうか (無いことは削除の失敗ではない) */
function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name?: unknown }).name === "NotFoundError"
  );
}

/**
 * OPFS のファイルを消す
 *
 * ファイルが無い (NotFoundError) ときは成功として扱う。それ以外の失敗 (権限、I/O など) は
 * 消せていないため false を返し、呼び出し側が保存の失敗として表示できるようにする。
 */
async function removeFile(
  directory: FileSystemDirectoryHandle,
  fileName: string,
): Promise<boolean> {
  try {
    await directory.removeEntry(fileName);
    return true;
  } catch (error) {
    return isNotFoundError(error);
  }
}

/** 候補一覧を OPFS に書く (移行時など、直列化を通さずに 1 回だけ書くときに使う) */
async function writeServerUrlEntries(
  directory: FileSystemDirectoryHandle,
  entries: readonly ServerUrlEntry[],
): Promise<void> {
  const handle = await directory.getFileHandle(SERVER_URLS_FILE, { create: true });
  const writable = await handle.createWritable();
  await writable.write(formatServerUrlEntries(entries));
  await writable.close();
}

/**
 * OPFS に保存した候補一覧を読む
 *
 * 保存したファイルが無く、以前の版の `server-url.txt` が残っているときは、その内容を
 * 有効な候補 1 件として移行する (次回から新しい形式を読む)。このオリジンだけから読める。
 * localStorage は使わない。
 */
export async function readServerUrlEntries(): Promise<ServerUrlEntry[]> {
  const directory = await privateDirectory();
  if (directory === null) {
    return [];
  }
  const stored = await readTextFile(directory, SERVER_URLS_FILE);
  if (stored !== null) {
    return parseServerUrlEntries(stored);
  }
  const legacy = await readTextFile(directory, LEGACY_SERVER_URL_FILE);
  if (legacy === null) {
    return [];
  }
  const entry = legacyServerUrlEntry(legacy);
  if (entry === null) {
    return [];
  }
  const entries = [entry];
  try {
    // 移行できてもできなくても、この page では候補を使える
    await writeServerUrlEntries(directory, entries);
    await removeFileIfExists(directory, LEGACY_SERVER_URL_FILE);
  } catch {
    // 移行できなかった場合は次回も旧形式を読む
  }
  return entries;
}

/** OPFS への書き込みを直列化する Promise チェーン */
let pendingServerUrlWrite: Promise<void> = Promise.resolve();

/** 候補一覧を OPFS に書く (空の一覧はファイルごと消す)。書けたら true */
async function writeServerUrlEntriesToOpfs(entries: readonly ServerUrlEntry[]): Promise<boolean> {
  try {
    const directory = await privateDirectory();
    if (directory === null) {
      return false;
    }
    if (entries.length === 0) {
      const removedCurrent = await removeFile(directory, SERVER_URLS_FILE);
      // 移行前の古いファイルが残っていても、消した候補が次回よみがえないようにする
      const removedLegacy = await removeFile(directory, LEGACY_SERVER_URL_FILE);
      return removedCurrent && removedLegacy;
    }
    await writeServerUrlEntries(directory, entries);
    return true;
  } catch {
    return false;
  }
}

/**
 * 候補一覧を OPFS に保存する
 *
 * モーダルの操作は連続して起きるため、書き込みを 1 本の Promise チェーンで直列化する。
 * 並行して書くと完了順が入れ替わり、古い一覧が最後に残ることがある (Remove all の
 * 削除が直後の Add の書き込みを追い越すなど)。
 *
 * 空の一覧はファイルごと消す。書けなくても画面の候補はそのまま使える (次に開いたときは
 * 保存前の一覧に戻る)。呼び出し側が保存できなかったことを表示できるよう、成否を返す。
 */
export function persistServerUrlEntries(entries: readonly ServerUrlEntry[]): Promise<boolean> {
  const snapshot = entries.map((entry) => ({ url: entry.url, enabled: entry.enabled }));
  const result = pendingServerUrlWrite.then(() => writeServerUrlEntriesToOpfs(snapshot));
  // 失敗してもチェーンを止めない (次の保存は試す)
  pendingServerUrlWrite = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}
