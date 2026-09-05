// DebugPanel で使用する純粋関数 formatter 群を集約する。
// JSX を含まず外部 signal も参照しないため utils/ 配下に置く。

// RFC 形式のフィールド名マッピング
export const RFC_FIELD_NAMES: Record<string, string> = {
  requestId: "Request ID",
  trackAlias: "Track Alias",
  trackNamespace: "Track Namespace",
  trackName: "Track Name",
  errorCode: "Error Code",
  reason: "Reason",
  statusCode: "Status Code",
  streamCount: "Stream Count",
  maxRequestId: "Max Request ID",
  trackNamespacePrefix: "Track Namespace Prefix",
  subscriptionRequestId: "Subscription Request ID",
};

// MOQT Parameter 名 (draft-ietf-moq-transport-20) は ALL_CAPS_WITH_UNDERSCORES。
// formatMessageData では Parameters セクションへ振り分けるために本関数で判定する。
export function isParameter(key: string): boolean {
  return key === key.toUpperCase() && key.includes("_");
}

// RFC 仕様書風のフォーマット
export function formatMessageData(data: unknown, indent = 0): string {
  if (data === null || data === undefined) {
    return "";
  }

  const spaces = "  ".repeat(indent);

  if (typeof data === "string") {
    return data;
  }

  if (typeof data === "number" || typeof data === "boolean" || typeof data === "bigint") {
    return String(data);
  }

  if (typeof data === "symbol" || typeof data === "function") {
    return String(data);
  }

  if (Array.isArray(data)) {
    if (data.length === 0) {
      return "[]";
    }
    const hasObjects = data.some((item) => typeof item === "object" && item !== null);
    if (hasObjects) {
      return JSON.stringify(data, null, 2);
    }
    return `[${data.join(", ")}]`;
  }

  const entries = Object.entries(data as Record<string, unknown>);
  if (entries.length === 0) {
    return "";
  }

  const fields: [string, unknown][] = [];
  const parameters: [string, unknown][] = [];

  for (const [key, value] of entries) {
    if (value === undefined) {
      continue;
    }
    if (isParameter(key)) {
      parameters.push([key, value]);
    } else {
      fields.push([key, value]);
    }
  }

  const lines: string[] = [];

  for (const [key, value] of fields) {
    const displayName = RFC_FIELD_NAMES[key] ?? key;
    if (key === "catalog" && typeof value === "object" && value !== null) {
      const jsonStr = JSON.stringify(value, null, 2);
      const indentedJson = jsonStr
        .split("\n")
        .map((line, i) => (i === 0 ? line : `${spaces}  ${line}`))
        .join("\n");
      lines.push(`${spaces}  ${displayName}: ${indentedJson}`);
    } else {
      const formattedValue = formatMessageData(value, indent + 1);
      lines.push(`${spaces}  ${displayName}: ${formattedValue}`);
    }
  }

  if (parameters.length > 0) {
    lines.push(`${spaces}  Parameters:`);
    for (const [key, value] of parameters) {
      const formattedValue = formatMessageData(value, indent + 2);
      lines.push(`${spaces}    ${key}: ${formattedValue}`);
    }
  }

  return `{\n${lines.join("\n")}\n${spaces}}`;
}

// バイナリデータを hex dump 形式でフォーマット
export function formatHexDump(data: Uint8Array): string {
  const lines: string[] = [];
  const bytesPerLine = 16;

  for (let offset = 0; offset < data.length; offset += bytesPerLine) {
    const chunk = data.slice(offset, offset + bytesPerLine);

    const offsetStr = offset.toString(16).padStart(4, "0");

    const hexParts: string[] = [];
    for (let i = 0; i < bytesPerLine; i++) {
      if (i < chunk.length) {
        hexParts.push(chunk[i].toString(16).padStart(2, "0"));
      } else {
        hexParts.push("  ");
      }
    }
    const hexStr = hexParts.slice(0, 8).join(" ") + "  " + hexParts.slice(8).join(" ");

    let asciiStr = "";
    for (let i = 0; i < chunk.length; i++) {
      const byte = chunk[i];
      if (byte >= 0x20 && byte <= 0x7e) {
        asciiStr += String.fromCharCode(byte);
      } else {
        asciiStr += ".";
      }
    }

    lines.push(`${offsetStr}  ${hexStr}  |${asciiStr}|`);
  }

  return lines.join("\n");
}

// 絶対時刻をフォーマット（HH:MM:SS.mmm）
export function formatAbsoluteTime(timestamp: number): string {
  const date = new Date(timestamp);
  const hours = date.getHours().toString().padStart(2, "0");
  const minutes = date.getMinutes().toString().padStart(2, "0");
  const seconds = date.getSeconds().toString().padStart(2, "0");
  const milliseconds = date.getMilliseconds().toString().padStart(3, "0");
  return `${hours}:${minutes}:${seconds}.${milliseconds}`;
}

// 経過時間をフォーマット (秒.ミリ秒)。
// 呼び出し側は firstTimestamp <= timestamp を保証する前提。
export function formatElapsedTime(timestamp: number, firstTimestamp: number): string {
  const elapsed = timestamp - firstTimestamp;
  const seconds = Math.floor(elapsed / 1000);
  const milliseconds = elapsed % 1000;
  return `+${seconds}.${milliseconds.toString().padStart(3, "0")}`;
}

// 差分時間をフォーマット (ミリ秒)。
// 呼び出し側は previousTimestamp <= currentTimestamp の昇順を保証する前提。
export function formatDeltaTime(
  currentTimestamp: number,
  previousTimestamp: number | null,
): string {
  if (previousTimestamp === null) {
    return "";
  }
  const delta = currentTimestamp - previousTimestamp;
  return `(+${delta}ms)`;
}
