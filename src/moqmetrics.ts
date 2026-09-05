/**
 * MOQ Metrics (moqmetrics) track payload
 * draft-jennings-moq-metrics-02 ([MOQMETRICS]) / draft-ietf-moq-msf-01 §10 (Metrics track)
 *
 * msf-01 §10.1 は Metrics track の payload を [MOQMETRICS] Section 3 の形式と定める（MUST）。
 * データモデルは Resource / Attributes / Metrics（Gauge | Counter、float64 | int64）。
 * src/moqlog.ts（Log track）と対の構成。
 *
 * 注意（Group ID epoch の不整合）:
 * - [MOQMETRICS] §3 は Group ID を "milliseconds since 1 Jan 1972 (NTP Era zero)" と定義する。
 * - msf-01 §10.3 は Group ID を "milliseconds since January 1, 1970 (Unix epoch)" と定義する。
 * 本モジュールでは Group ID は msf-01 §10.3 に従い Unix epoch ミリ秒を正とする。
 *
 * 注意（Group ID と Object 0 timestamp の単位差）:
 * - Group ID はミリ秒（msf-01 §10.3 / [MOQMETRICS] §3）。
 * - Object 0 の capture timestamp は Unix epoch ナノ秒（msf-01 §10.3 / [MOQMETRICS] §3）。
 * 単位が 10^6 倍異なるため、相互変換は呼び出し側の責任とする。
 *
 * 注意（track naming は暫定）:
 * msf-01 §10.2 には "TODO: Finalize the track naming" があり、namespace / track name 形式は未確定。
 * 本モジュールの helper は [MOQMETRICS] Section 3 の現行テキストに従う暫定対応であり、
 * 仕様確定時に helper 内部の修正で済むように隔離している。
 */

import { ProtocolViolationError } from "./error";

/**
 * Object ID 0 の payload（[MOQMETRICS] Section 3 / msf-01 §10.3）
 *
 * capture timestamp（Unix epoch ナノ秒）と optional な attributes を持つ。
 * attributes は key-value 文字列の配列（[MOQMETRICS] §2 / §3.1 例）。
 * 未知フィールドは round-trip で破棄しない（索引シグネチャで保持する）。
 */
export interface MetricsCaptureObject {
  /**
   * capture timestamp（Unix epoch ナノ秒、msf-01 §10.3）
   *
   * 注意: JSON number は Number.MAX_SAFE_INTEGER（2^53-1）を超える値の精度を失う。
   * 現在時刻のナノ秒はこれを超えるため、厳密なナノ秒精度が必要な場合は呼び出し側で
   * 桁数を調整すること（[MOQMETRICS] §3.1 の例は安全な整数を使う）。
   */
  capture_timestamp: number;
  /** Resource にスコープされた attributes（optional、key-value 文字列） */
  attributes?: Record<string, string>[];
  /** 未知フィールド */
  [key: string]: unknown;
}

/**
 * Object ID 1 以降の payload（[MOQMETRICS] Section 3 / msf-01 §10.3）
 *
 * metric name と対応する値の pair。metric_name は optional（省略時は直近 group の
 * 同一 Object ID の metric name を継承）。値は Gauge / Counter の float64 / int64。
 */
export interface MetricObject {
  /** metric name（ASCII 英数字・アンダースコア・コロン、optional） */
  metric_name?: string;
  /**
   * Gauge / Counter の値（float64 または int64、[MOQMETRICS] §2）
   *
   * 注意: int64 値が Number.MAX_SAFE_INTEGER（2^53-1）を超える場合、JSON number 表現で
   * 精度を失う（capture_timestamp と同一の論点）。
   */
  value: number;
  /** 未知フィールド */
  [key: string]: unknown;
}

/**
 * metrics granularity level の文字列 ↔ 優先度（0-7）の対応
 * draft-ietf-moq-msf-01 §10.2 / [MOQMETRICS] §3。syslog severity と同一規約。
 */
export const METRICS_GRANULARITY_LEVELS: Readonly<Record<string, number>> = {
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
 * payload バイト列を JSON object にデコードする共通処理。
 *
 * @throws ProtocolViolationError JSON が不正、または object でない場合
 */
function decodeJsonObject(data: Uint8Array, what: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    // 不正 UTF-8 を U+FFFD に置換せず throw させ、ProtocolViolationError 経路に載せる
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ProtocolViolationError(`invalid ${what} payload JSON: ${message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ProtocolViolationError(`${what} payload must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

/**
 * Object ID 0 の payload（capture timestamp + attributes）をエンコードする。
 */
export function encodeCaptureObject(obj: MetricsCaptureObject): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(obj));
}

/**
 * Object ID 0 の payload（capture timestamp + attributes）をデコードする。
 *
 * @throws ProtocolViolationError JSON が不正、または object でない場合
 */
export function decodeCaptureObject(data: Uint8Array): MetricsCaptureObject {
  return decodeJsonObject(data, "moqmetrics capture object") as MetricsCaptureObject;
}

/**
 * Object ID 1 以降の payload（metric name-value pair）をエンコードする。
 */
export function encodeMetricObject(obj: MetricObject): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(obj));
}

/**
 * Object ID 1 以降の payload（metric name-value pair）をデコードする。
 *
 * @throws ProtocolViolationError JSON が不正、または object でない場合
 */
export function decodeMetricObject(data: Uint8Array): MetricObject {
  return decodeJsonObject(data, "moqmetrics metric object") as MetricObject;
}

/**
 * Group ID の 62-bit truncate マスク（draft-ietf-moq-msf-01 §10.3）
 */
const GROUP_ID_MASK_62 = (1n << 62n) - 1n;

/**
 * Metrics track の Group ID を計算する（draft-ietf-moq-msf-01 §10.3）
 *
 * Group ID は capture time（Unix epoch からのミリ秒）を 62-bit バイナリ整数に
 * truncate した値。時間順の自然な並びを実現する。
 *
 * @param timestampMs Unix epoch からのミリ秒（非負）
 * @throws Error timestampMs が負の場合
 */
export function metricsGroupId(timestampMs: bigint): bigint {
  if (timestampMs < 0n) {
    throw new Error(`metrics group timestamp must be non-negative: ${timestampMs}`);
  }
  return timestampMs & GROUP_ID_MASK_62;
}

/**
 * Object ID 0 は capture timestamp + attributes（draft-ietf-moq-msf-01 §10.3）
 */
export const METRICS_CAPTURE_OBJECT_ID = 0n;

/**
 * metric name-value pair の Object ID を計算する（draft-ietf-moq-msf-01 §10.3）
 *
 * Object ID 0 は capture 用のため、metric は 1 以降。metricIndex は 0 始まりの
 * metric 順序で、Object ID = metricIndex + 1。
 *
 * @param metricIndex 0 始まりの metric 順序
 * @throws Error metricIndex が非負整数でない場合
 */
export function metricObjectId(metricIndex: number): bigint {
  if (!Number.isInteger(metricIndex) || metricIndex < 0) {
    throw new Error(`metric index must be a non-negative integer: ${metricIndex}`);
  }
  return BigInt(metricIndex) + 1n;
}

/**
 * Metrics track の Track Namespace prefix（[MOQMETRICS] Section 3 / msf-01 §10.2、暫定対応）
 *
 * TrackNamespace は (moq://metrics.moq.arpa/v1/),(resourceID) の 2 タプル。
 * msf-01 §10.2 は "TODO: Finalize the track naming" のため、この形式は暫定。
 */
export const MOQMETRICS_NAMESPACE_PREFIX = "moq://metrics.moq.arpa/v1/";

/**
 * Metrics track の Track Namespace タプルを構築する（[MOQMETRICS] Section 3、暫定対応）
 *
 * resourceID は非空であること。draft-ietf-moq-transport-20 §2.4.1 は各 namespace 要素に
 * 1 バイト以上を MUST とし、空要素は下流の Track Namespace エンコードで拒否される。
 */
export function metricsTrackNamespace(resourceId: string): [string, string] {
  return [MOQMETRICS_NAMESPACE_PREFIX, resourceId];
}

/**
 * Metrics track の Track Name を構築する（[MOQMETRICS] Section 3 / msf-01 §10.2、暫定対応）
 *
 * Track Name は metrics granularity level の 1 バイト（0=Emergency - 7=Debug）。
 *
 * @param granularityLevel granularity level（0-7）
 * @throws Error granularityLevel が 0-7 の整数でない場合
 */
export function metricsTrackName(granularityLevel: number): Uint8Array {
  if (!Number.isInteger(granularityLevel) || granularityLevel < 0 || granularityLevel > 7) {
    throw new Error(`metrics granularity level must be an integer 0-7: ${granularityLevel}`);
  }
  return new Uint8Array([granularityLevel]);
}
