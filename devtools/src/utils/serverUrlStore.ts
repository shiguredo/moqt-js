/**
 * Relay URI を OPFS に残すかの判定と、ファイルの中身の読み方
 *
 * 覚えるのは Save を押したときだけ。Forget を押したときは消す。
 */

export type StoredServerUrlAction = { kind: "write"; url: string } | { kind: "delete" };

/**
 * 今の Relay URI を OPFS に書くか、消すか
 *
 * Save (`save` が true) のときは書く。空欄なら消す。
 * Forget (`save` が false) のときは消す。
 */
export function storedServerUrlAction(current: string, save: boolean): StoredServerUrlAction {
  if (!save) {
    return { kind: "delete" };
  }
  const url = current.trim();
  if (url === "") {
    return { kind: "delete" };
  }
  return { kind: "write", url };
}

/**
 * OPFS から読んだ文字列を Relay URI にする
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

export interface RelayUriMemoryButtons {
  saveEnabled: boolean;
  forgetEnabled: boolean;
}

/**
 * Relay URI 欄の Save / Forget
 *
 * 押せるのは片方だけ。覚えていないとき、および欄を覚えた URI から変えたときは Save。
 * 覚えた URI と欄が同じとき、および覚えたあと欄を空にしたときは Forget。
 * 空欄でまだ覚えていないときはどちらも押せない。
 */
export function relayUriMemoryButtons(
  saved: string | null,
  current: string,
): RelayUriMemoryButtons {
  const trimmed = current.trim();
  if (saved !== null && (trimmed === saved || trimmed === "")) {
    return { saveEnabled: false, forgetEnabled: true };
  }
  return { saveEnabled: trimmed !== "", forgetEnabled: false };
}

/**
 * 検索文字列から、共有リンクの Relay URI を取り出す
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

/** OPFS 上の Relay URI。このオリジンだけから読める */
const SERVER_URL_FILE = "server-url.txt";

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
 * OPFS に覚えた Relay URI を読む
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
 * Save が付いているときだけ OPFS に書く。Forget のときは消す
 *
 * 書けなくても画面の入力はそのまま使える。
 */
export async function persistServerUrl(current: string, save: boolean): Promise<void> {
  const action = storedServerUrlAction(current, save);
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
    // 覚えられなくても、今の Relay URI はそのまま使える
  }
}
