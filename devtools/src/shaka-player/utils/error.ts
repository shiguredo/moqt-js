/** 未知のエラーを画面に出す 1 行の文字列にする。 */
export function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return formatShakaError(error);
}

/**
 * 画面でよく出る MSF のエラーコードに名前を付ける。
 *
 * shaka のコンパイル済み build ではエラー名の定数が公開されず、
 * message も "Shaka Error 4065" だけになるため、コードから名前を補う。
 */
const ERROR_CODE_NAMES: ReadonlyMap<number, string> = new Map([
  [4032, "CONTENT_UNSUPPORTED_BY_BROWSER"],
  [4058, "MSF_VOD_CONTENT_NOT_SUPPORTED"],
  [4064, "MSF_CATALOG_TIMEOUT"],
  [4065, "MSF_CONNECTION_CLOSED"],
  [4066, "MSF_SUBSCRIBE_FAILED"],
  [4067, "MSF_UNSUPPORTED_COMPRESSION"],
  [4068, "MSF_UNSUPPORTED_CATALOG_VERSION"],
]);

/**
 * shaka.util.Error を category / code / message の形にする。
 *
 * shaka のコンパイル済み build は Error のサブクラスを公開しないため、
 * instanceof ではなくプロパティの形で判定する。
 */
export function formatShakaError(error: unknown): string {
  if (!isRecord(error)) {
    return String(error);
  }
  const category = readNumber(error, "category");
  const code = readNumber(error, "code");
  const message = readString(error, "message");
  const dataText = describeData(error["data"]);
  const codeName = code === null ? null : ERROR_CODE_NAMES.get(code);
  const codeText =
    code === null ? null : codeName === undefined ? `code=${code}` : `code=${code} (${codeName})`;
  const categoryText = category === null ? null : `category=${category}`;
  const header = [categoryText, codeText].filter((part) => part !== null).join(" ");
  const details = [message !== null && message !== "" ? message : null, dataText]
    .filter((part) => part !== null && part !== "")
    .join(": ");
  if (header !== "") {
    return `shaka error ${header}${details === "" ? "" : `: ${details}`}`;
  }
  return details !== "" ? details : "unknown shaka error";
}

/**
 * shaka の error.data から画面に出せる文字列を取り出す。
 *
 * data は配列やオブジェクトであり、そのまま String() すると
 * [object Object] になるため、既知の形だけを読む。
 */
function describeData(data: unknown): string | null {
  if (typeof data === "string") {
    return data;
  }
  if (Array.isArray(data)) {
    const parts = data.filter((item): item is string => typeof item === "string");
    return parts.length > 0 ? parts.join(": ") : null;
  }
  if (isRecord(data)) {
    const reason = data["reason"];
    return typeof reason === "string" ? reason : null;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readNumber(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === "number" ? value : null;
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}
