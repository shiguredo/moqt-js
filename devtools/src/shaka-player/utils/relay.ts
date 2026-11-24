/**
 * 接続設定の正規化と URL 共有。
 *
 * MOQT URI は shaka-player の WebTransport が https:// を要求するため、
 * 画面では moqt:// と https:// の両方を受け付けて https:// に揃える。
 * 仕様の根拠: draft-ietf-moq-transport-23 §3.1 (WebTransport) と
 * draft-ietf-moq-msf-02 §4 (MSF の URL)。
 */

export interface ShareState {
  relayUrl: string;
  namespaceText: string;
  version: string;
  fingerprintUri: string;
  evictionGoal: string;
}

// 4 秒のシーク範囲を使う LOC 再生で、キーフレーム間隔 10 秒の映像が消えないようにする。
// 8 秒は Shaka の既定 1 秒とは異なり、シーク範囲の先頭を基準にした早期削除を避ける。
const DEFAULT_EVICTION_GOAL_SECONDS = 8;

export const VERSION_OPTIONS = [
  { value: "auto", label: "Auto" },
  { value: "draft-23", label: "draft-23" },
  { value: "draft-22", label: "draft-22" },
  { value: "draft-21", label: "draft-21" },
  { value: "draft-20", label: "draft-20" },
  { value: "draft-18", label: "draft-18" },
] as const;

export type VersionValue = (typeof VERSION_OPTIONS)[number]["value"];

/**
 * 入力されたリレー URL を shaka-player が受け取れる https:// に正規化する。
 *
 * 空文字、壊れた URL、moqt:// と https:// 以外の scheme はエラーにする。
 * http:// を許すとブラウザーの WebTransport が失敗するため、ここで拒否する。
 */
export function normalizeRelayUrl(input: string): string {
  const trimmed = input.trim();
  if (trimmed === "") {
    throw new Error("relay URL is empty");
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`relay URL is not a valid URL: ${trimmed}`);
  }

  if (url.protocol === "moqt:") {
    // URL の protocol setter は非 special scheme から special scheme への
    // 切り替えを黙って無視することがあるため、新しい URL を作り直す。
    url = new URL(`https://${url.href.slice("moqt://".length)}`);
  } else if (url.protocol !== "https:") {
    throw new Error(`relay URL must use moqt:// or https://: ${trimmed}`);
  }

  if (url.host === "") {
    throw new Error(`relay URL has no host: ${trimmed}`);
  }
  return url.toString();
}

/**
 * Relay URL を画面表示用にマスクする。
 *
 * パスワード input はブラウザのパスワードマネージャーに拾われるため使わない。
 * scheme と明示的な port だけを残し、host / path / query は *** に置き換える。
 */
export function maskRelayUrl(input: string): string {
  const trimmed = input.trim();
  if (trimmed === "") {
    return "";
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return "***";
  }
  const port = url.port === "" ? "" : `:${url.port}`;
  return `${url.protocol}//***${port}/`;
}

/**
 * devtools と同じ - 区切りの namespace-name 文字列をフィールドへ分解する。
 *
 * draft-ietf-moq-transport-23 §8.8 の namespace-name は - を区切りにし、
 * リテラルな byte は .hh (2 桁の 16 進) で書く。Shaka の namespaces は
 * string[] なので、ASCII の範囲だけをサポートする。
 */
function parseNamespaceName(input: string): string[] {
  const fields: string[] = [];
  let current = "";
  for (let index = 0; index < input.length; index += 1) {
    const character = input.charAt(index);
    if (character === "-") {
      fields.push(current);
      current = "";
      continue;
    }
    if (character === ".") {
      const hex = input.slice(index + 1, index + 3);
      if (!/^[0-9a-fA-F]{2}$/.test(hex)) {
        throw new Error(`invalid Track Namespace escape in: ${input}`);
      }
      const byte = Number.parseInt(hex, 16);
      if (byte > 0x7f) {
        throw new Error(`non-ASCII Track Namespace escape is not supported: .${hex}`);
      }
      current += String.fromCharCode(byte);
      index += 2;
      continue;
    }
    current += character;
  }
  fields.push(current);
  if (fields.some((field) => field === "")) {
    throw new Error(`Track Namespace has an empty field: ${input}`);
  }
  return fields;
}

/**
 * namespace の入力を Shaka の manifest.msf.namespaces 用のフィールド列にする。
 *
 * 次の 2 つの形式を受け付ける。
 * - "/" 区切り: Shaka の画面用。例 "shaka-demo/abc123"
 * - "-" 区切り: moqt-devtools と同じ namespace-name 文字列。
 *   例 "moqt-devtools-abc" は ['moqt', 'devtools', 'abc']
 *   .hh エスケープもこの形式で解釈する。
 *
 * 複数行の入力は 1 つの namespace ではないためエラーにする。
 */
export function parseNamespace(input: string): string[] {
  const trimmed = input.trim();
  if (trimmed === "") {
    throw new Error("Track Namespace is empty");
  }
  if (/\r?\n/.test(trimmed)) {
    throw new Error("only one Track Namespace is supported");
  }
  if (trimmed.includes("/")) {
    const fields = trimmed.split("/").map((field) => field.trim());
    if (fields.some((field) => field === "")) {
      throw new Error(`Track Namespace has an empty field: ${trimmed}`);
    }
    return fields;
  }
  return parseNamespaceName(trimmed);
}

export function isVersionValue(value: string): value is VersionValue {
  return VERSION_OPTIONS.some((option) => option.value === value);
}

function readEvictionGoalSeconds(input: string): number | null {
  const trimmed = input.trim();
  const seconds = Number(trimmed);
  return /^\d+$/.test(trimmed) && Number.isSafeInteger(seconds) && seconds > 0 ? seconds : null;
}

/** フォームの入力は、暗黙に既定値へ戻さず、空欄や不正値をエラーにする。 */
export function parseEvictionGoalSeconds(input: string): number {
  const seconds = readEvictionGoalSeconds(input);
  if (seconds === null) {
    throw new Error(
      `Buffer Eviction Goal must be a positive whole number of seconds, got ${JSON.stringify(input)}`,
    );
  }
  return seconds;
}

/**
 * Copy URL 用のクエリを作る。
 *
 * Authorization Token は URL に載せない。トークンは秘密情報であり、
 * 共有 URL から漏れると relay へのアクセス権がそのまま渡ってしまうため。
 */
export function buildShareQuery(state: ShareState): string {
  const params = new URLSearchParams();
  if (state.relayUrl.trim() !== "") {
    params.set("url", state.relayUrl.trim());
  }
  if (state.namespaceText.trim() !== "") {
    params.set("namespace", state.namespaceText.trim());
  }
  if (state.version !== "" && state.version !== "auto") {
    params.set("version", state.version);
  }
  if (state.fingerprintUri.trim() !== "") {
    params.set("fingerprintUri", state.fingerprintUri.trim());
  }
  const evictionGoal = parseEvictionGoalSeconds(state.evictionGoal);
  if (evictionGoal !== DEFAULT_EVICTION_GOAL_SECONDS) {
    params.set("evictionGoal", String(evictionGoal));
  }
  return params.toString();
}

export function parseShareQuery(search: string): ShareState {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const version = params.get("version") ?? "auto";
  const evictionGoal = readEvictionGoalSeconds(params.get("evictionGoal") ?? "");
  return {
    relayUrl: params.get("url") ?? "",
    namespaceText: params.get("namespace") ?? "",
    version: isVersionValue(version) ? version : "auto",
    fingerprintUri: params.get("fingerprintUri") ?? "",
    evictionGoal: String(evictionGoal ?? DEFAULT_EVICTION_GOAL_SECONDS),
  };
}

export function buildShareUrl(href: string, state: ShareState): string {
  const url = new URL(href);
  url.search = buildShareQuery(state);
  url.hash = "";
  return url.toString();
}
