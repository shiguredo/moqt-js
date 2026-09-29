// DebugPanel で使用する純粋関数 formatter 群を集約する。
// JSX を含まず外部 signal も参照しないため utils/ 配下に置く。

import { formatFullTrackName, formatTrackNamespace } from "../../../src/fullTrackName.ts";

// RFC 形式のフィールド名マッピング
export const RFC_FIELD_NAMES: Record<string, string> = {
  requestId: "Request ID",
  trackAlias: "Track Alias",
  trackNamespace: "Track Namespace",
  trackName: "Track Name",
  // trackNamespace + trackName の組を 1 行にまとめたときに使う表示名
  fullTrackName: "Full Track Name",
  errorCode: "Error Code",
  reason: "Reason",
  statusCode: "Status Code",
  streamCount: "Stream Count",
  maxRequestId: "Max Request ID",
  trackNamespacePrefix: "Track Namespace Prefix",
  subscriptionRequestId: "Subscription Request ID",
};

/**
 * Track Namespace Field の配列かどうか
 *
 * decoded には wire の値がそのまま入るため、string[] 以外 (バイト列など) も来る。
 * 文字列の配列のときだけ §8.8 の表記へ組み立てる
 */
function isTrackNamespaceFields(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((field) => typeof field === "string");
}

/**
 * trackNamespace + trackName を Full Track Name の表記にする (組み立てられないときは null)
 *
 * 空の Track Namespace Field など §8.8 の表記にできない値では
 * formatFullTrackName が throw する。ログ表示を壊さないよう、そのときは null を
 * 返して呼び出し側が生の値を出す
 */
function tryFormatFullTrackName(trackNamespace: unknown, trackName: unknown): string | null {
  if (!isTrackNamespaceFields(trackNamespace) || typeof trackName !== "string") {
    return null;
  }
  try {
    return formatFullTrackName(trackNamespace, trackName);
  } catch {
    return null;
  }
}

/**
 * Track Namespace 単体を §8.8 の表記にする (組み立てられないときは null)
 *
 * trackNamespace + trackName の組が無いメッセージ (PUBLISH_NAMESPACE など) と
 * trackNamespacePrefix で使う
 */
function tryFormatTrackNamespace(value: unknown): string | null {
  if (!isTrackNamespaceFields(value)) {
    return null;
  }
  try {
    return formatTrackNamespace(value);
  } catch {
    return null;
  }
}

/**
 * MOQT Parameter 名 (draft-ietf-moq-transport-21) は ALL_CAPS_WITH_UNDERSCORES。
 * formatMessageData では Parameters セクションへ振り分けるために本関数で判定する。
 */
export function isParameter(key: string): boolean {
  return key === key.toUpperCase() && key.includes("_");
}

/**
 * RFC 仕様書風のフォーマット
 *
 * trackNamespace + trackName の組は `Full Track Name: room-123--video` の 1 行に
 * まとめる (§8.8 の表記)。namespace 単体と trackNamespacePrefix は `-` 区切りの
 * 表記にする。表記にできない値 (バイト列や空の Track Namespace Field) は生の値の
 * まま出す
 */
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

  // trackNamespace と trackName の組を Full Track Name の 1 行にまとめるため、
  // 同じオブジェクトのもう一方の値を引けるようにする
  const entryValues = new Map(entries);

  for (const [key, value] of entries) {
    if (value === undefined) {
      continue;
    }
    if (key === "trackName") {
      // trackNamespace と組で Full Track Name にできるときは、trackNamespace の側で出す
      if (tryFormatFullTrackName(entryValues.get("trackNamespace"), value) !== null) {
        continue;
      }
    }
    if (key === "trackNamespace") {
      const fullTrackName = tryFormatFullTrackName(value, entryValues.get("trackName"));
      if (fullTrackName !== null) {
        fields.push(["fullTrackName", fullTrackName]);
        continue;
      }
      // trackName が無いメッセージ (PUBLISH_NAMESPACE など) は namespace 単体の表記にする。
      // 空の namespace (0 フィールド) は表記が空文字列になるため生の値 ("[]") のまま出す
      const namespace = tryFormatTrackNamespace(value);
      fields.push([key, namespace === null || namespace === "" ? value : namespace]);
      continue;
    }
    if (key === "trackNamespacePrefix") {
      const namespace = tryFormatTrackNamespace(value);
      fields.push([key, namespace === null || namespace === "" ? value : namespace]);
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

/**
 * ログ行の末尾に付ける Full Track Name (trackNamespace + trackName があるときだけ)
 *
 * メッセージのログ行は `[publisher] [SEND] PUBLISH` のように種別だけを出すため、
 * どのトラックのメッセージかを行から読めるようにする。表記にできない値では
 * 何も付けない
 */
export function formatTrackNameSuffix(decoded: Record<string, unknown> | undefined): string {
  if (decoded === undefined) {
    return "";
  }
  const fullTrackName = tryFormatFullTrackName(decoded["trackNamespace"], decoded["trackName"]);
  return fullTrackName === null ? "" : ` ${fullTrackName}`;
}

// バイナリデータを hex dump 形式でフォーマット
export function formatHexDump(data: Uint8Array): string {
  const lines: string[] = [];
  const bytesPerLine = 16;

  for (let offset = 0; offset < data.length; offset += bytesPerLine) {
    const chunk = data.slice(offset, offset + bytesPerLine);

    const offsetStr = offset.toString(16).padStart(4, "0");

    const hexParts: string[] = [];
    // for...of で各バイトを取り出す (noUncheckedIndexedAccess で index access は
    // 型上 undefined を含むため、要素走査で回避する)
    for (const byte of chunk) {
      hexParts.push(byte.toString(16).padStart(2, "0"));
    }
    // 16 バイト未満の最終行は残りを空白で埋め、hex 列と ASCII 列の位置を揃える
    for (let i = chunk.length; i < bytesPerLine; i++) {
      hexParts.push("  ");
    }
    const hexStr = hexParts.slice(0, 8).join(" ") + "  " + hexParts.slice(8).join(" ");

    let asciiStr = "";
    for (const byte of chunk) {
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

// バイト数を表示用にフォーマットする。
// devtools 内で唯一の実装とし、各パネルはこれを import する
// (以前は codec.ts / webcodecs-devtools/signals.ts / DebugPanel.tsx に
//  丸めの異なる実装が並立していた)。
// 1024 進のため、単位は 2 進接頭辞 (KiB / MiB) にして 1000 進の KB / MB と区別する。
// ビットレート (formatBitrate) は 1000 進のまま kbps / Mbps を使う
export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}

// ビットレートを表示用にフォーマットする。formatBytes と同じく唯一の実装。
// 単位は 1000 進 (通信速度の慣例)、バイト数は 1024 進 (ストレージの慣例)。
export function formatBitrate(bps: number): string {
  if (bps < 1000) {
    return `${bps} bps`;
  }
  if (bps < 1000 * 1000) {
    return `${(bps / 1000).toFixed(0)} kbps`;
  }
  return `${(bps / 1000 / 1000).toFixed(1)} Mbps`;
}
