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
 * 注意（track naming）:
 * namespace / track name は [MOQMETRICS] Section 3 ではなく moq-metrics-03 §5.1 に従う。
 * MSF-01 §10.2 は旧 metrics-02 を参照しており "TODO: Finalize the track naming." のままである。
 * payload は引き続き metrics-02 §3 の JSON であり、Catalog / Capture Info / Metric Value
 * への移行は別の変更で行う。
 */

import { ProtocolViolationError } from "./error";
import {
  decodeObservabilityJson,
  observabilityGroupId,
  observabilityNamespaceTemplate,
  observabilityTrackName,
  observabilityTrackNamespace,
  SYSLOG_LEVELS,
} from "./observability";
import { CATALOG_TRACK_NAME } from "./msf/version";

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
 *
 * 実体は MOQLOG の severity と共通の表 (./observability)。
 */
export const METRICS_GRANULARITY_LEVELS: Readonly<Record<string, number>> = SYSLOG_LEVELS;

/**
 * Object ID 0 の payload（capture timestamp + attributes）をエンコードする。
 *
 * 既知数値フィールドの非有限値のみ fail-fast する
 * (型誤りはデコード側で拒否し、attributes・未知フィールド内の非有限は対象外とする)。
 *
 * @throws Error capture_timestamp が数値型の非有限数の場合
 */
export function encodeCaptureObject(obj: MetricsCaptureObject): Uint8Array {
  if (typeof obj.capture_timestamp === "number" && !Number.isFinite(obj.capture_timestamp)) {
    throw new Error(
      `cannot encode moqmetrics capture object with non-finite capture_timestamp: ${obj.capture_timestamp}`,
    );
  }
  return new TextEncoder().encode(JSON.stringify(obj));
}

/**
 * Object ID 0 の payload（capture timestamp + attributes）をデコードする。
 *
 * @throws ProtocolViolationError JSON が不正、object でない場合、
 * capture_timestamp が欠落または有限数でない場合
 */
export function decodeCaptureObject(data: Uint8Array): MetricsCaptureObject {
  const parsed = decodeObservabilityJson(data, "moqmetrics capture object");
  const timestamp = parsed["capture_timestamp"];
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) {
    throw new ProtocolViolationError(
      `invalid moqmetrics capture object: capture_timestamp must be a finite number, got ${JSON.stringify(timestamp)}`,
    );
  }
  return parsed as MetricsCaptureObject;
}

/**
 * Object ID 1 以降の payload（metric name-value pair）をエンコードする。
 *
 * 既知数値フィールドの非有限値のみ fail-fast する
 * (型誤りはデコード側で拒否し、未知フィールド内の非有限は対象外とする)。
 *
 * @throws Error value が数値型の非有限数の場合
 */
export function encodeMetricObject(obj: MetricObject): Uint8Array {
  if (typeof obj.value === "number" && !Number.isFinite(obj.value)) {
    throw new Error(`cannot encode moqmetrics metric object with non-finite value: ${obj.value}`);
  }
  return new TextEncoder().encode(JSON.stringify(obj));
}

/**
 * Object ID 1 以降の payload（metric name-value pair）をデコードする。
 *
 * @throws ProtocolViolationError JSON が不正、object でない場合、
 * value が欠落または有限数でない場合
 */
export function decodeMetricObject(data: Uint8Array): MetricObject {
  const parsed = decodeObservabilityJson(data, "moqmetrics metric object");
  const value = parsed["value"];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ProtocolViolationError(
      `invalid moqmetrics metric object: value must be a finite number, got ${JSON.stringify(value)}`,
    );
  }
  return parsed as MetricObject;
}

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
  return observabilityGroupId(timestampMs, "metrics group");
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
 * Metrics track の Track Namespace の固定 2 field（moq-metrics-03 §5.1）
 *
 * 実際の Track Namespace は ("metrics.moq.arpa", "v1", <resourceID>) の 3 field。
 */
export const MOQMETRICS_NAMESPACE_PREFIX = Object.freeze(["metrics.moq.arpa", "v1"] as const);

/**
 * Metrics track の Track Namespace タプルを構築する（moq-metrics-03 §5.1）
 *
 * resourceID は 16 桁の小文字 hexadecimal ASCII である。
 *
 * @param resourceId - 16 桁の小文字 hexadecimal ASCII の resource ID
 * @throws Error resourceId が 16 桁小文字 hexadecimal でない場合
 */
export function metricsTrackNamespace(resourceId: string): [string, string, string] {
  return observabilityTrackNamespace(MOQMETRICS_NAMESPACE_PREFIX, resourceId, "moqmetrics");
}

/**
 * Metrics track の MSF publishTracks 用 namespace テンプレート（moq-metrics-03 §6）
 *
 * `metrics.2emoq.2earpa-v1-%resourceId%` を返す。利用者は `%resourceId%` を
 * 16 桁の小文字 hexadecimal に置換する。
 */
export const MOQMETRICS_NAMESPACE_TEMPLATE = observabilityNamespaceTemplate(
  MOQMETRICS_NAMESPACE_PREFIX,
);

/**
 * Metrics track の Track Name を構築する（moq-metrics-03 §5.1 / §5.2）
 *
 * Track Name は granularity level を表す ASCII 数字 1 バイト
 * （0=Emergency - 7=Debug）。
 *
 * @param granularityLevel granularity level（0-7）
 * @throws Error granularityLevel が 0-7 の整数でない場合
 */
export function metricsTrackName(granularityLevel: number): Uint8Array {
  return observabilityTrackName(granularityLevel, "metrics granularity");
}

/**
 * Metrics catalog track の Track Name を構築する（moq-metrics-03 §5.1）
 *
 * catalog Track Name は ASCII の "catalog" で、data track の "0"〜"7" とは別である。
 */
export function metricsCatalogTrackName(): Uint8Array {
  return new TextEncoder().encode(CATALOG_TRACK_NAME);
}
