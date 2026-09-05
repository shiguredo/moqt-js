/**
 * MOQ Log (moqlog) track payload
 * draft-jennings-moq-log-03 ([MOQLOG]) / draft-ietf-moq-msf-01 §9 (Log track)
 *
 * msf-01 §9.1 は Log track の payload を [MOQLOG] Section 4 の JSON 形式と定める（MUST）。
 * 各 MOQT Object は 1 つの JSON ログエントリを含む。
 *
 * 注意（timestamp epoch の不整合）:
 * - [MOQLOG] §4 は payload の timestamp を "microseconds since 1 Jan 1972 (NTP Era zero)" と定義する。
 * - msf-01 §9.3 は Group ID を "microseconds since the Unix epoch (1970)" と定義する。
 * - [MOQLOG] §7 の例（timestamp=3155587200）は本文・§4 定義のいずれとも整合しない。
 * 本モジュールでは Group ID は msf-01 §9.3（Unix epoch マイクロ秒）、payload timestamp は
 * [MOQLOG] §4 の記述に従う。payload timestamp の意味変換は呼び出し側の責任とする。
 *
 * 注意（track naming は暫定）:
 * msf-01 §9.2 には "TODO: Finalize on track naming" があり、namespace / track name 形式は未確定。
 * 本モジュールの helper は [MOQLOG] Section 3 の現行テキストに従う暫定対応であり、
 * 仕様確定時に helper 内部の修正で済むように隔離している。
 */

import { ProtocolViolationError } from "./error";

/**
 * Log entry ([MOQLOG] Section 4)
 *
 * 全フィールド optional の JSON object。未知フィールドは [RFC5424] の
 * structured data として扱い、round-trip で破棄しない（索引シグネチャで保持する）。
 */
export interface LogEntry {
  /** [RFC5424] severity。"Emergency", "Alert", ... "Debug"（[MOQLOG] §4） */
  severity?: string;
  /** マイクロ秒（[MOQLOG] §4: since 1 Jan 1972, NTP Era zero） */
  timestamp?: number;
  /** [RFC5424] pri。0-23、欠落時の既定は 1（[MOQLOG] §4） */
  pri?: number;
  /** [RFC5424] hostname（hostname とは限らない） */
  hostname?: string;
  /** [RFC5424] appname */
  appname?: string;
  /** [RFC5424] procid */
  procid?: string;
  /** [RFC5424] msgid */
  msgid?: string;
  /** [RFC5424] msg（UTF-8 文字列） */
  msg?: string;
  /** 未知フィールド（TraceID / SpanID / InstrumentationScope 等の structured data） */
  [key: string]: unknown;
}

/**
 * syslog severity の文字列 ↔ 優先度（0-7）の対応
 * draft-ietf-moq-msf-01 §9.2 / [RFC5424] の規約に従う。
 *
 * 注意: [MOQLOG] §7 の例は "Info" という短縮形を使うが、§4 本文の正規形は
 * "Informational" である。本表は §4 本文の正規形（フルスペル）を正とする。
 */
export const LOG_SEVERITY_LEVELS: Readonly<Record<string, number>> = {
  Emergency: 0,
  Alert: 1,
  Critical: 2,
  Error: 3,
  Warning: 4,
  Notice: 5,
  Informational: 6,
  Debug: 7,
};

/**
 * Log entry を Object Payload バイト列にエンコードする（[MOQLOG] Section 4）
 */
export function encodeLogEntry(entry: LogEntry): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(entry));
}

/**
 * Object Payload バイト列を Log entry にデコードする（[MOQLOG] Section 4）
 *
 * payload は JSON object でなければならない（[MOQLOG] §4）。
 * 未知フィールドは structured data としてそのまま保持する。
 *
 * @throws ProtocolViolationError JSON が不正、または object でない場合
 */
export function decodeLogEntry(data: Uint8Array): LogEntry {
  let parsed: unknown;
  try {
    // 不正 UTF-8 を U+FFFD に置換せず throw させ、ProtocolViolationError 経路に載せる
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ProtocolViolationError(`invalid moqlog payload JSON: ${message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ProtocolViolationError("moqlog payload must be a JSON object");
  }
  return parsed as LogEntry;
}

/**
 * Group ID の 62-bit truncate マスク（draft-ietf-moq-msf-01 §9.3）
 */
const GROUP_ID_MASK_62 = (1n << 62n) - 1n;

/**
 * Log entry の Group ID を計算する（draft-ietf-moq-msf-01 §9.3）
 *
 * Group ID は log entry 取得時の timestamp（Unix epoch からのマイクロ秒）を
 * 62-bit バイナリ整数に truncate した値。時間順の自然な並びを実現する。
 *
 * @param timestampMicros Unix epoch からのマイクロ秒（非負）
 * @throws Error timestampMicros が負の場合
 */
export function logGroupId(timestampMicros: bigint): bigint {
  if (timestampMicros < 0n) {
    throw new Error(`log group timestamp must be non-negative: ${timestampMicros}`);
  }
  return timestampMicros & GROUP_ID_MASK_62;
}

/**
 * Log entry の Object ID を計算する（draft-ietf-moq-msf-01 §9.3）
 *
 * Object ID は通常 0。同一マイクロ秒内に複数のログメッセージがある場合のみ、
 * 同一 timestamp 内の連番（0 始まり）で区別する。
 *
 * @param sequenceInMicrosecond 同一マイクロ秒内の 0 始まり連番
 * @throws Error sequenceInMicrosecond が非負整数でない場合
 */
export function logObjectId(sequenceInMicrosecond: number): bigint {
  if (!Number.isInteger(sequenceInMicrosecond) || sequenceInMicrosecond < 0) {
    throw new Error(`log object sequence must be a non-negative integer: ${sequenceInMicrosecond}`);
  }
  return BigInt(sequenceInMicrosecond);
}

/**
 * Log track の Track Namespace prefix（[MOQLOG] Section 3 / msf-01 §9.2、暫定対応）
 *
 * TrackNamespace は (moq://moq-syslog.arpa/logs-v1/),(resourceID) の 2 タプル。
 * msf-01 §9.2 は "TODO: Finalize on track naming" のため、この形式は暫定。
 */
export const MOQLOG_NAMESPACE_PREFIX = "moq://moq-syslog.arpa/logs-v1/";

/**
 * Log track の Track Namespace タプルを構築する（[MOQLOG] Section 3、暫定対応）
 *
 * resourceID は非空であること。draft-ietf-moq-transport-20 §2.4.1 は各 namespace 要素に
 * 1 バイト以上を MUST とし、空要素は下流の Track Namespace エンコードで拒否される。
 */
export function logTrackNamespace(resourceId: string): [string, string] {
  return [MOQLOG_NAMESPACE_PREFIX, resourceId];
}

/**
 * Log track の Track Name を構築する（[MOQLOG] Section 3 / msf-01 §9.2、暫定対応）
 *
 * Track Name は log priority level をバイナリで持つ 1 バイト（0=Emergency - 7=Debug）。
 *
 * @param severityLevel syslog 優先度（0-7）
 * @throws Error severityLevel が 0-7 の整数でない場合
 */
export function logTrackName(severityLevel: number): Uint8Array {
  if (!Number.isInteger(severityLevel) || severityLevel < 0 || severityLevel > 7) {
    throw new Error(`log priority level must be an integer 0-7: ${severityLevel}`);
  }
  return new Uint8Array([severityLevel]);
}
