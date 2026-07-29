/**
 * MOQMETRICS (Metrics track payload)
 * draft-jennings-moq-metrics-02 Section 3
 * draft-ietf-moq-msf-01 §10 (Metrics track)
 *
 * 注意: draft-jennings-moq-metrics-02 は Expires: 2026-04-23 で期限切れ。
 * 後継 draft は存在しないが、msf-01 が MUST 参照するため現時点で最新の参照仕様。
 *
 * 注意: [MOQMETRICS] §3 の Group ID は "milliseconds since 1 Jan 1972 (NTP Era zero)"
 * と定義するが、msf-01 §10.3 は "milliseconds since January 1, 1970 (Unix epoch)"
 * と定義する。本モジュールでは Group ID は msf-01 §10.3 に従い Unix epoch ミリ秒とする。
 *
 * 注意: Group ID はミリ秒、Object 0 の capture timestamp はナノ秒。
 * 単位が 10^6 倍異なる。実装時に相互変換が必要。
 *
 * 注意: [MOQMETRICS] §3.1 の JSON 例には構文誤りあり（value: 99 キー引用符なし、
 * JSON 内コメント）。本実装では正しい JSON 形式に従う。
 */

// ============================================================
// データモデル型定義 ([MOQMETRICS] Section 2 / Section 3)
// ============================================================

/**
 * Metrics Object ID 0: capture timestamp + attributes
 *
 * msf-01 §10.3: Object ID 0 = capture timestamp (Unix epoch ナノ秒) + attributes
 */
export interface MetricsCaptureObject {
  /** Unix epoch からのナノ秒 */
  captureTimestamp: bigint;
  /** リソースのスコープ付き属性（省略可。省略時は直近の Object 0 の属性を継承） */
  attributes?: MetricsAttribute[];
}

/**
 * Metrics の属性（key-value 対）
 */
export type MetricsAttribute = Record<string, string>;

/**
 * Metrics Object ID 1 以降: metric name-value pair
 *
 * msf-01 §10.3: Object ID 1 以降 = metric name-value pair
 * 値は float64 または int64 (Gauge / Counter)
 */
export interface MetricsValueObject {
  /** メトリクス名（省略可。省略時は同一 Object ID の直近グループのメトリクス名を継承） */
  metricName?: string;
  /** メトリクス値 (float64 または int64) */
  value: number;
}

// ============================================================
// encode / decode (JSON 形式)
// ============================================================

/**
 * MetricsCaptureObject を JSON バイト列にエンコードする
 *
 * capture_timestamp はナノ秒の整数。JSON では number として表現する。
 * BigInt のままでは JSON.stringify できないため Number に変換する。
 * 2^53 を超えるナノ秒値は精度を失うが、現時点の Unix epoch ナノ秒は
 * 約 1.7 * 10^18 であり Number.MAX_SAFE_INTEGER (約 9 * 10^15) を超える。
 * 精度を保持するため文字列としてエンコードする。
 */
export function encodeMetricsCaptureObject(obj: MetricsCaptureObject): Uint8Array {
  const json: Record<string, unknown> = {
    capture_timestamp: obj.captureTimestamp.toString(),
  };
  if (obj.attributes && obj.attributes.length > 0) {
    json["attributes"] = obj.attributes;
  }
  return new TextEncoder().encode(JSON.stringify(json));
}

/**
 * JSON バイト列を MetricsCaptureObject にデコードする
 */
export function decodeMetricsCaptureObject(data: Uint8Array): MetricsCaptureObject {
  const json = JSON.parse(new TextDecoder().decode(data)) as Record<string, unknown>;
  const rawTimestamp = json["capture_timestamp"];
  let captureTimestamp: bigint;
  if (typeof rawTimestamp === "string") {
    captureTimestamp = BigInt(rawTimestamp);
  } else if (typeof rawTimestamp === "number") {
    captureTimestamp = BigInt(Math.trunc(rawTimestamp));
  } else {
    throw new Error("capture_timestamp must be a string or number");
  }

  const result: MetricsCaptureObject = { captureTimestamp };
  if (Array.isArray(json["attributes"])) {
    result.attributes = json["attributes"] as MetricsAttribute[];
  }
  return result;
}

/**
 * MetricsValueObject を JSON バイト列にエンコードする
 */
export function encodeMetricsValueObject(obj: MetricsValueObject): Uint8Array {
  const json: Record<string, unknown> = {
    value: obj.value,
  };
  if (obj.metricName !== undefined) {
    json["metric_name"] = obj.metricName;
  }
  return new TextEncoder().encode(JSON.stringify(json));
}

/**
 * JSON バイト列を MetricsValueObject にデコードする
 */
export function decodeMetricsValueObject(data: Uint8Array): MetricsValueObject {
  const json = JSON.parse(new TextDecoder().decode(data)) as Record<string, unknown>;
  const result: MetricsValueObject = {
    value: json["value"] as number,
  };
  if (typeof json["metric_name"] === "string") {
    result.metricName = json["metric_name"];
  }
  return result;
}

// ============================================================
// Group ID / Object ID helper (msf-01 §10.3)
// ============================================================

/**
 * 62-bit の最大値 (2^62 - 1)
 */
const MAX_62_BIT = (1n << 62n) - 1n;

/**
 * Metrics track の Group ID を生成する
 *
 * draft-ietf-moq-msf-01 §10.3:
 * Group ID = capture time (Unix epoch からのミリ秒) を 62-bit に truncate。
 *
 * @param timestampMs - Unix epoch からのミリ秒
 * @returns 62-bit に truncate された Group ID
 */
export function createMetricsGroupId(timestampMs: bigint): bigint {
  return timestampMs & MAX_62_BIT;
}

/**
 * Metrics track の Object ID を返す
 *
 * msf-01 §10.3:
 * - Object ID 0: capture timestamp + attributes
 * - Object ID 1 以降: metric name-value pair
 *
 * @param index - 0 = capture object, 1 以降 = metric value object
 */
export function createMetricsObjectId(index: number): number {
  return index;
}

// ============================================================
// Namespace / Track Name helper
// ============================================================

/**
 * Metrics track の Track Namespace を構築する
 *
 * 注意: msf-01 §10.2 には "TODO: Finalize the track naming" があり未確定。
 * 本 helper は [MOQMETRICS] Section 3 の現行テキストに従う暫定対応。
 * 仕様確定時に helper 内部の修正で済むように隔離している。
 *
 * [MOQMETRICS] §3: TrackName = "resourceID/granularity"
 *
 * @param resourceId - リソースの識別子
 */
export function buildMetricsTrackNamespace(resourceId: string): string[] {
  return ["moq://moq-metrics.arpa/metrics-v1/", resourceId];
}

/**
 * Metrics track の Track Name を構築する
 *
 * [MOQMETRICS] §3: TrackName = "resourceID/granularity"
 * granularity は syslog severity level (0=Emergency 〜 7=Debug) に準拠。
 *
 * @param resourceId - リソースの識別子
 * @param granularity - 粒度レベル (0-7)
 */
export function buildMetricsTrackName(resourceId: string, granularity: number): string {
  if (granularity < 0 || granularity > 7) {
    throw new Error(`metrics granularity level must be 0-7: ${granularity}`);
  }
  return `${resourceId}/${granularity}`;
}
