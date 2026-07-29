/**
 * MOQLOG (Log track payload)
 * draft-jennings-moq-log-03 Section 4 (Object Data)
 * draft-ietf-moq-msf-01 §9 (Log track)
 *
 * 注意: draft-jennings-moq-log-03 は Expires: 2026-04-23 で期限切れ。
 * 後継 draft は存在しないが、msf-01 が MUST 参照するため現時点で最新の参照仕様。
 *
 * 注意: [MOQLOG] §4 の timestamp は "microseconds since 1 Jan 1972 (NTP Era zero)"
 * と定義するが、msf-01 §9.3 の Group ID は "microseconds since the Unix epoch (1970)"
 * と定義する。本モジュールでは Group ID は msf-01 §9.3 に従い Unix epoch マイクロ秒、
 * payload timestamp は [MOQLOG] §4 の記述に従う。
 * [MOQLOG] 内部の不整合（§7 の例 timestamp=3155587200 は 1900 起点の秒としか一致しない）
 * は仕様側の問題であり、本実装では §4 の本文記述を正とする。
 */

// ============================================================
// Log Entry 型定義 ([MOQLOG] Section 4)
// ============================================================

/**
 * syslog severity レベル ([MOQLOG] §4 / RFC5424)
 */
export type LogSeverity =
  | "Emergency"
  | "Alert"
  | "Critical"
  | "Error"
  | "Warning"
  | "Notice"
  | "Info"
  | "Debug";

/**
 * Log Entry ([MOQLOG] Section 4 Object Data)
 *
 * 全フィールド optional の JSON object。
 * 未知フィールドは structured data として保持する（round-trip で破棄しない）。
 */
export interface LogEntry {
  /** RFC5424 の severity 文字列 */
  severity?: LogSeverity;
  /** [MOQLOG] §4: microseconds since 1 Jan 1972 (NTP Era zero) */
  timestamp?: number;
  /** RFC5424 の pri (0-23)。未指定時のデフォルトは 1 */
  pri?: number;
  /** RFC5424 の hostname */
  hostname?: string;
  /** RFC5424 の appname */
  appname?: string;
  /** RFC5424 の procid */
  procid?: string;
  /** RFC5424 の msgid */
  msgid?: string;
  /** RFC5424 の msg (UTF-8 文字列) */
  msg?: string;
  /** 未知フィールド（structured data / OTEL attributes 等） */
  [key: string]: unknown;
}

// ============================================================
// encode / decode
// ============================================================

/**
 * LogEntry を JSON バイト列にエンコードする
 *
 * [MOQLOG] §4: Object Data は JSON object。
 * undefined フィールドは JSON に含めない（JSON.stringify の既定挙動）。
 */
export function encodeLogEntry(entry: LogEntry): Uint8Array {
  const json = JSON.stringify(entry);
  return new TextEncoder().encode(json);
}

/**
 * JSON バイト列を LogEntry にデコードする
 *
 * 未知フィールドはそのまま保持する（structured data として round-trip 可能）。
 */
export function decodeLogEntry(data: Uint8Array): LogEntry {
  const json = new TextDecoder().decode(data);
  return JSON.parse(json) as LogEntry;
}

// ============================================================
// Group ID / Object ID helper (msf-01 §9.3)
// ============================================================

/**
 * 62-bit の最大値 (2^62 - 1)
 */
const MAX_62_BIT = (1n << 62n) - 1n;

/**
 * Log track の Group ID を生成する
 *
 * draft-ietf-moq-msf-01 §9.3:
 * Group ID = timestamp (Unix epoch からのマイクロ秒) を 62-bit に truncate。
 *
 * @param timestampUs - Unix epoch からのマイクロ秒
 * @returns 62-bit に truncate された Group ID
 */
export function createLogGroupId(timestampUs: bigint): bigint {
  return timestampUs & MAX_62_BIT;
}

/**
 * Log track の Object ID を生成する
 *
 * draft-ietf-moq-msf-01 §9.3:
 * Object ID = 同一マイクロ秒内の連番（0 始まり）。
 * 通常は 0。同一マイクロ秒に複数メッセージがある場合のみ 1 以降。
 *
 * @param sequenceInMicrosecond - 同一マイクロ秒内の 0-based 連番
 */
export function createLogObjectId(sequenceInMicrosecond: number): number {
  return sequenceInMicrosecond;
}

// ============================================================
// Namespace / Track Name helper
// ============================================================

/**
 * Log track の Track Namespace を構築する
 *
 * 注意: msf-01 §9.2 には "TODO: Finalize on track naming" があり未確定。
 * 本 helper は [MOQLOG] Section 3 の現行テキストに従う暫定対応。
 * 仕様確定時に helper 内部の修正で済むように隔離している。
 *
 * [MOQLOG] §3: "(moq://moq-syslog.arpa/logs-v1/),(resourceID)"
 *
 * @param resourceId - ログソースの識別子
 */
export function buildLogTrackNamespace(resourceId: string): string[] {
  return ["moq://moq-syslog.arpa/logs-v1/", resourceId];
}

/**
 * syslog severity レベルを Track Name バイトに変換する
 *
 * [MOQLOG] §3: Track Name は log priority level の 1 バイト (0=Emergency 〜 7=Debug)。
 *
 * @param level - 0 (Emergency) 〜 7 (Debug)
 */
export function buildLogTrackName(level: number): Uint8Array {
  if (level < 0 || level > 7) {
    throw new Error(`log priority level must be 0-7: ${level}`);
  }
  return new Uint8Array([level]);
}

/**
 * severity 文字列を syslog priority level (0-7) に変換する
 */
export function severityToLevel(severity: LogSeverity): number {
  const levels: Record<LogSeverity, number> = {
    Emergency: 0,
    Alert: 1,
    Critical: 2,
    Error: 3,
    Warning: 4,
    Notice: 5,
    Info: 6,
    Debug: 7,
  };
  return levels[severity];
}

/**
 * syslog priority level (0-7) を severity 文字列に変換する
 */
export function levelToSeverity(level: number): LogSeverity {
  const severities: LogSeverity[] = [
    "Emergency",
    "Alert",
    "Critical",
    "Error",
    "Warning",
    "Notice",
    "Info",
    "Debug",
  ];
  if (level < 0 || level > 7) {
    throw new Error(`log priority level must be 0-7: ${level}`);
  }
  return severities[level];
}
