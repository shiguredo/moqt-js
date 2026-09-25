/**
 * Server URL を OPFS に残すかの判定と、ファイルの中身の読み方
 *
 * クエリの `url` は共有リンクなので、その値のままでは覚え直さない。
 * 空欄は「覚えない」ではなく、覚えていた URL を消す。
 */

export type StoredServerUrlAction =
  | { kind: "skip" }
  | { kind: "write"; url: string }
  | { kind: "delete" };

/**
 * 今の Server URL を OPFS に書くか、消すか、何もしないか
 *
 * `queryUrl` と一字一句同じときは、共有リンクを開いただけなので書かない。
 */
export function storedServerUrlAction(
  current: string,
  queryUrl: string | null,
): StoredServerUrlAction {
  if (queryUrl !== null && current === queryUrl) {
    return { kind: "skip" };
  }
  const url = current.trim();
  if (url === "") {
    return { kind: "delete" };
  }
  return { kind: "write", url };
}

/**
 * OPFS から読んだ文字列を Server URL にする
 *
 * 空、または改行を含むものは覚えていないものとして扱う。
 */
export function parseStoredServerUrl(raw: string): string | null {
  const text = raw.trim();
  if (text === "" || text.includes("\n") || text.includes("\r")) {
    return null;
  }
  return text;
}

/**
 * 検索文字列から、共有リンクの Server URL を取り出す
 *
 * 無い、または空白だけのときは null。
 */
export function queryServerUrl(search: string): string | null {
  const value = new URLSearchParams(search).get("url");
  if (value === null) {
    return null;
  }
  const url = value.trim();
  if (url === "") {
    return null;
  }
  return url;
}

/** OPFS 上の Server URL。このオリジンだけから読める */
const SERVER_URL_FILE = "server-url.txt";

// このページを開いたときの共有リンクの url。無いときは null。
// 同じ値のままでは OPFS を上書きしない
let notedQueryServerUrl: string | null = null;

/** 起動時に、クエリの url を覚えておく対象から外す */
export function noteQueryServerUrl(search: string): void {
  notedQueryServerUrl = queryServerUrl(search);
}

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

/**
 * OPFS に覚えた Server URL を読む
 *
 * ファイルが無い、または読めないときは null。localStorage は使わない。
 */
export async function readStoredServerUrl(): Promise<string | null> {
  try {
    const root = await privateDirectory();
    if (root === null) {
      return null;
    }
    const handle = await root.getFileHandle(SERVER_URL_FILE);
    const file = await handle.getFile();
    return parseStoredServerUrl(await file.text());
  } catch {
    return null;
  }
}

/**
 * 今の Server URL を OPFS に書く。共有リンクのままなら何もしない
 *
 * 書けなくても画面の入力はそのまま使える。
 */
export async function persistServerUrl(current: string): Promise<void> {
  const action = storedServerUrlAction(current, notedQueryServerUrl);
  if (action.kind === "skip") {
    return;
  }
  try {
    const root = await privateDirectory();
    if (root === null) {
      return;
    }
    if (action.kind === "delete") {
      await root.removeEntry(SERVER_URL_FILE);
      return;
    }
    const handle = await root.getFileHandle(SERVER_URL_FILE, { create: true });
    const writable = await handle.createWritable();
    await writable.write(action.url);
    await writable.close();
  } catch {
    // 覚えられなくても、今の Server URL はそのまま使える
  }
}
