/**
 * MOQ Metrics (moqmetrics) track payload
 * draft-jennings-moq-metrics-03 ([MOQMETRICS]) / draft-ietf-moq-msf-01 §10 (Metrics track)
 *
 * msf-01 §10.1 は Metrics track の payload を旧 metrics-02 §3 の JSON 形式と定めている（MUST）。
 * 本モジュールは metrics-03 の catalog（§5.3）を扱い、data Object は引き続き
 * metrics-02 §3 の JSON 形式である。data の Capture Info / Metric Value の codec は
 * 別の変更で置き換える。src/moqlog.ts（Log track）と対の構成。
 *
 * catalog:
 * - catalog track は Resource Attributes と Metric Description を保持し、Subgroup delivery を使う（MUST）。
 * - Group ID は catalog version（1 始まり）であり、Header の format Version とは別である。
 * - Object 0 が Header、Object N が Metric Index N の Description である。
 * - data Object N の解釈には、参照する catalog version の Object N だけが必要である。
 * 全 catalog や前の data Group を参照しない。catalog を data より先に送る（MUST）。
 *
 * Metric Index:
 * - 1 つの catalog version 内で resource 全体に一意であり、data track ごとに振り直さない。
 * - 複数の data track は同じ version の同じ Index を同じ metric として参照する。
 * - 新しい version では再割当してよい（MAY）が、Object ID filter を保つため可能な限り
 * 同じ Index を維持する（SHOULD）。
 *
 * 推奨 Track Properties:
 * catalog の MAX_CACHE_DURATION は全 data track より短くせず、DEFAULT_PUBLISHER_PRIORITY は
 * 全 data track より数値を小さくし、OBJECT_DELIVERY_TIMEOUT を付けない。MSF publishTracks で
 * data を配信する場合も、同じ namespace の catalog を同じ connectionUri / token で公開する。
 * 未取得 version の FETCH は利用者の責務であり、自動購読基盤は提供しない。
 *
 * 注意（Group ID epoch の不整合）:
 * - metrics-02 §3 は Group ID を "milliseconds since 1 Jan 1972 (NTP Era zero)" と定義する。
 * - msf-01 §10.3 は Group ID を "milliseconds since January 1, 1970 (Unix epoch)" と定義する。
 * 本モジュールでは Group ID は msf-01 §10.3 に従い Unix epoch ミリ秒を正とする。
 *
 * 注意（data track の Group ID と Object 0 timestamp の単位差）:
 * - data track の Group ID はミリ秒（msf-01 §10.3 / 旧 metrics-02 §3）。
 * - catalog の Group ID は catalog version であり、ミリ秒ではない。
 * - Object 0 の capture timestamp は Unix epoch ナノ秒（msf-01 §10.3 / metrics-02 §3）。
 * 単位が 10^6 倍異なるため、相互変換は呼び出し側の責任とする。
 *
 * 注意（track naming）:
 * namespace / track name は旧 metrics-02 §3 ではなく moq-metrics-03 §5.1 に従う。
 * MSF-01 §10.2 は旧 metrics-02 を参照しており "TODO: Finalize the track naming." のままである。
 */

import { concatUint8Arrays } from "./bytes";
import { ProtocolViolationError, SessionErrorCode } from "./error";
import {
  decodeAscii as decodeAsciiShared,
  decodeUtf8 as decodeUtf8Shared,
  encodeAscii as encodeAsciiShared,
  encodeLengthPrefixed,
  encodeUtf8 as encodeUtf8Shared,
  describeType,
  readBytes as readBytesShared,
  readVarint as readVarintShared,
  type DecodeCursor,
} from "./observabilityCodec";
import { encodeVarint, MAX_VARINT } from "./varint";
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
 * Object ID 0 の payload（旧 metrics-02 §3 / msf-01 §10.3）
 *
 * capture timestamp（Unix epoch ナノ秒）と optional な attributes を持つ。
 * attributes は key-value 文字列の配列（旧 metrics-02 §2 / §3.1 例）。
 * 未知フィールドは round-trip で破棄しない（索引シグネチャで保持する）。
 */
export interface MetricsCaptureObject {
  /**
   * capture timestamp（Unix epoch ナノ秒、msf-01 §10.3）
   *
   * 注意: JSON number は Number.MAX_SAFE_INTEGER（2^53-1）を超える値の精度を失う。
   * 現在時刻のナノ秒はこれを超えるため、厳密なナノ秒精度が必要な場合は呼び出し側で
   * 桁数を調整すること（旧 metrics-02 §3.1 の例は安全な整数を使う）。
   */
  capture_timestamp: number;
  /** Resource にスコープされた attributes（optional、key-value 文字列） */
  attributes?: Record<string, string>[];
  /** 未知フィールド */
  [key: string]: unknown;
}

/**
 * Object ID 1 以降の payload（旧 metrics-02 §3 / msf-01 §10.3）
 *
 * metric name と対応する値の pair。旧 metrics-02 の data では metric_name を省略すると
 * 直近 group の同一 Object ID の metric name を継承する。metrics-03 の data では
 * catalog の Object N の Description を使うため、この継承は使わない。
 * 値は Gauge / Counter の float64 / int64。
 */
export interface MetricObject {
  /** metric name（ASCII 英数字・アンダースコア・コロン、optional） */
  metric_name?: string;
  /**
   * Gauge / Counter の値（float64 または int64、旧 metrics-02 §2）
   *
   * 注意: int64 値が Number.MAX_SAFE_INTEGER（2^53-1）を超える場合、JSON number 表現で
   * 精度を失う（capture_timestamp と同一の論点）。
   */
  value: number;
  /** 未知フィールド */
  [key: string]: unknown;
}

/**
 * Catalog の Resource Attribute（[MOQMETRICS] §5.3）
 *
 * Key / Value は UTF-8。配列の順序と重複キーを保持する。
 */
export interface MetricsCatalogAttribute {
  key: string;
  value: string;
}

/**
 * Catalog Header（[MOQMETRICS] §5.3）
 *
 * Object 0 に置き、format Version と Resource Attributes を持つ。
 */
export interface MetricsCatalogHeader {
  /** catalog の format Version。現在は 1 のみ */
  formatVersion: bigint;
  /** Resource Attributes（順序と重複キーを保持する） */
  attributes: readonly MetricsCatalogAttribute[];
}

/**
 * Metric Type（[MOQMETRICS] §5.3）
 */
export type MetricType = "gauge" | "counter";

/**
 * Metric Value Representation（[MOQMETRICS] §5.3）
 */
export type MetricValueRepresentation = "unsigned" | "signed" | "float";

/**
 * Metric Description（[MOQMETRICS] §5.3）
 *
 * catalog の Object N に置き、data Object N の Metric Index N を説明する。
 */
export interface MetricDescription {
  metricType: MetricType;
  valueRepresentation: MetricValueRepresentation;
  /**
   * metric 名。ASCII の英数字・アンダースコア・コロン。
   * 空文字は metric 名として無意味なため実装で拒否する（仕様に明文の禁止はない）。
   */
  name: string;
  /** 単位（UTF-8、空文字可） */
  unit: string;
}

/**
 * Catalog Header の format Version（[MOQMETRICS] §5.3）
 */
export const METRICS_CATALOG_FORMAT_VERSION = 1n;

const METRIC_NAME_PATTERN = /^[A-Za-z0-9_:]+$/;
const METRIC_NAME_REQUIREMENT = "non-empty ASCII alphanumerics, underscore, or colon";

const METRIC_TYPE_TO_CODE: Readonly<Record<MetricType, bigint>> = Object.freeze({
  gauge: 0n,
  counter: 1n,
});

const METRIC_VALUE_REPRESENTATION_TO_CODE: Readonly<Record<MetricValueRepresentation, bigint>> =
  Object.freeze({
    unsigned: 0n,
    signed: 1n,
    float: 2n,
  });

const METRICS_LABEL = "moqmetrics";

function encodeUtf8(value: string, field: string): Uint8Array {
  return encodeUtf8Shared(value, METRICS_LABEL, field);
}

function decodeUtf8(data: Uint8Array, field: string): string {
  return decodeUtf8Shared(data, METRICS_LABEL, field);
}

function encodeAscii(value: string, field: string): Uint8Array {
  return encodeAsciiShared(value, METRICS_LABEL, field);
}

function decodeAscii(data: Uint8Array, field: string): string {
  return decodeAsciiShared(data, METRICS_LABEL, field);
}

function readVarint(data: Uint8Array, cursor: DecodeCursor, field: string): bigint {
  return readVarintShared(data, cursor, METRICS_LABEL, field);
}

function readBytes(
  data: Uint8Array,
  cursor: DecodeCursor,
  length: bigint,
  field: string,
): Uint8Array {
  return readBytesShared(data, cursor, length, METRICS_LABEL, field);
}

function encodeMetricType(value: MetricType): Uint8Array {
  if (!Object.hasOwn(METRIC_TYPE_TO_CODE, value)) {
    throw new Error(`moqmetrics metricType must be gauge or counter: ${value}`);
  }
  return encodeVarint(METRIC_TYPE_TO_CODE[value]);
}

function encodeMetricValueRepresentation(value: MetricValueRepresentation): Uint8Array {
  if (!Object.hasOwn(METRIC_VALUE_REPRESENTATION_TO_CODE, value)) {
    throw new Error(`moqmetrics valueRepresentation must be unsigned, signed, or float: ${value}`);
  }
  return encodeVarint(METRIC_VALUE_REPRESENTATION_TO_CODE[value]);
}

function decodeMetricType(value: bigint): MetricType {
  if (value === 0n) return "gauge";
  if (value === 1n) return "counter";
  throw new ProtocolViolationError(
    `invalid moqmetrics metricType: ${value} must be 0 (gauge) or 1 (counter)`,
    SessionErrorCode.MALFORMED_OBJECT,
  );
}

function decodeMetricValueRepresentation(value: bigint): MetricValueRepresentation {
  if (value === 0n) return "unsigned";
  if (value === 1n) return "signed";
  if (value === 2n) return "float";
  throw new ProtocolViolationError(
    `invalid moqmetrics valueRepresentation: ${value} must be 0 (unsigned), 1 (signed), or 2 (float)`,
    SessionErrorCode.MALFORMED_OBJECT,
  );
}

/**
 * Catalog Header を Object Payload バイト列にエンコードする（[MOQMETRICS] §5.3）
 *
 * @throws Error formatVersion が 1 でない、attribute が不正な場合
 */
export function encodeMetricsCatalogHeader(header: MetricsCatalogHeader): Uint8Array {
  if (typeof header !== "object" || header === null) {
    throw new Error(`moqmetrics catalog header must be an object: ${describeType(header)}`);
  }
  if (typeof header.formatVersion !== "bigint") {
    throw new Error(
      `moqmetrics catalog formatVersion must be a bigint: ${describeType(header.formatVersion)}`,
    );
  }
  if (header.formatVersion !== METRICS_CATALOG_FORMAT_VERSION) {
    throw new Error(
      `moqmetrics catalog formatVersion must be ${METRICS_CATALOG_FORMAT_VERSION}: ${String(header.formatVersion)}`,
    );
  }
  if (!Array.isArray(header.attributes)) {
    throw new Error(
      `moqmetrics catalog attributes must be an array: ${describeType(header.attributes)}`,
    );
  }
  const parts: Uint8Array[] = [
    encodeVarint(header.formatVersion),
    encodeVarint(header.attributes.length),
  ];
  for (const [index, attribute] of header.attributes.entries()) {
    if (typeof attribute !== "object" || attribute === null) {
      throw new Error(
        `moqmetrics catalog attributes[${index}] must be an object: ${describeType(attribute)}`,
      );
    }
    parts.push(
      encodeLengthPrefixed(encodeUtf8(attribute.key, `attributes[${index}].key`)),
      encodeLengthPrefixed(encodeUtf8(attribute.value, `attributes[${index}].value`)),
    );
  }
  return concatUint8Arrays(parts);
}

/**
 * Catalog Header を Object Payload バイト列からデコードする（[MOQMETRICS] §5.3）
 *
 * 定義済みフィールドの後のバイトは将来拡張として無視する。
 *
 * @throws IncompleteDataError データが切り詰められている場合。
 * 完全な Object Payload を期待する呼び出し側は MALFORMED_OBJECT へ変換する
 * @throws ProtocolViolationError 未知の formatVersion、UTF-8 / 長さの違反がある場合。
 * code は MALFORMED_OBJECT
 */
export function decodeMetricsCatalogHeader(data: Uint8Array): MetricsCatalogHeader {
  const cursor: DecodeCursor = { offset: 0 };
  const formatVersion = readVarint(data, cursor, "format version");
  if (formatVersion !== METRICS_CATALOG_FORMAT_VERSION) {
    throw new ProtocolViolationError(
      `invalid moqmetrics catalog formatVersion: ${formatVersion} must be ${METRICS_CATALOG_FORMAT_VERSION}`,
      SessionErrorCode.MALFORMED_OBJECT,
    );
  }
  const attributeCount = readVarint(data, cursor, "attribute count");
  const attributes: MetricsCatalogAttribute[] = [];
  for (let index = 0n; index < attributeCount; index += 1n) {
    const key = decodeUtf8(
      readBytes(
        data,
        cursor,
        readVarint(data, cursor, `attributes[${index}].key length`),
        `attributes[${index}].key`,
      ),
      `attributes[${index}].key`,
    );
    const value = decodeUtf8(
      readBytes(
        data,
        cursor,
        readVarint(data, cursor, `attributes[${index}].value length`),
        `attributes[${index}].value`,
      ),
      `attributes[${index}].value`,
    );
    attributes.push({ key, value });
  }
  return { formatVersion, attributes };
}

/**
 * Metric Description を Object Payload バイト列にエンコードする（[MOQMETRICS] §5.3）
 *
 * @throws Error Metric Type / Value Representation / Name が不正な場合
 */
export function encodeMetricDescription(description: MetricDescription): Uint8Array {
  if (typeof description !== "object" || description === null) {
    throw new Error(
      `moqmetrics metric description must be an object: ${describeType(description)}`,
    );
  }
  if (typeof description.name !== "string" || !METRIC_NAME_PATTERN.test(description.name)) {
    throw new Error(
      `moqmetrics metric name must be ${METRIC_NAME_REQUIREMENT}: ${describeType(description.name)}`,
    );
  }
  return concatUint8Arrays([
    encodeMetricType(description.metricType),
    encodeMetricValueRepresentation(description.valueRepresentation),
    encodeLengthPrefixed(encodeAscii(description.name, "metric name")),
    encodeLengthPrefixed(encodeUtf8(description.unit, "unit")),
  ]);
}

/**
 * Metric Description を Object Payload バイト列からデコードする（[MOQMETRICS] §5.3）
 *
 * 定義済みフィールドの後のバイトは将来拡張として無視する。
 *
 * @throws IncompleteDataError データが切り詰められている場合。
 * 完全な Object Payload を期待する呼び出し側は MALFORMED_OBJECT へ変換する
 * @throws ProtocolViolationError 未知の Metric Type / Value Representation、
 * ASCII / UTF-8 / 長さの違反がある場合。code は MALFORMED_OBJECT
 */
export function decodeMetricDescription(data: Uint8Array): MetricDescription {
  const cursor: DecodeCursor = { offset: 0 };
  const metricType = decodeMetricType(readVarint(data, cursor, "metric type"));
  const valueRepresentation = decodeMetricValueRepresentation(
    readVarint(data, cursor, "value representation"),
  );
  const name = decodeAscii(
    readBytes(data, cursor, readVarint(data, cursor, "metric name length"), "metric name"),
    "metric name",
  );
  if (!METRIC_NAME_PATTERN.test(name)) {
    throw new ProtocolViolationError(
      `invalid moqmetrics metric name: ${JSON.stringify(name)} must be ${METRIC_NAME_REQUIREMENT}`,
      SessionErrorCode.MALFORMED_OBJECT,
    );
  }
  const unit = decodeUtf8(
    readBytes(data, cursor, readVarint(data, cursor, "unit length"), "unit"),
    "unit",
  );
  return { metricType, valueRepresentation, name, unit };
}

/**
 * metrics granularity level の文字列 ↔ 優先度（0-7）の対応
 * draft-ietf-moq-msf-01 §10.2 / [MOQMETRICS] §5.2。syslog severity と同じ 8 段階を使う。
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
 * data track の Group ID は capture time（msf-01 §10.3 の Unix epoch ミリ秒）を
 * 62-bit バイナリ整数に truncate した値（truncate は旧 metrics-02 §3。metrics-02 の
 * epoch は 1972 起点である点に注意）。時間順の自然な並びを実現する。
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
 * catalog の Group ID を計算する（[MOQMETRICS] §5.3）
 *
 * catalog の Group ID は catalog version（1 始まり）そのものである。
 * Header の format Version とは別であり、混同しない。
 * 最初の version は 1、更新ごとに +1 する。
 *
 * `Publisher.sendObject` の `groupId` は number (0〜2^53-1) のため `Number()` で渡す。
 * 2^53-1 を超える version はこの helper の検証範囲内でも精度を保証しない
 * (送信層は `Number.isSafeInteger` を検査しない)。
 *
 * @param version catalog version（1 以上 2^64-1 以下）
 * @throws Error version が bigint でない、または 1..2^64-1 の範囲外の場合
 */
export function metricsCatalogGroupId(version: bigint): bigint {
  if (typeof version !== "bigint") {
    throw new Error(`catalog version must be a bigint: ${describeType(version)}`);
  }
  if (version < 1n || version > MAX_VARINT) {
    throw new Error(`catalog version must be 1..${MAX_VARINT}: ${version}`);
  }
  return version;
}

/**
 * Metric Index から data Object の Object ID を計算する（[MOQMETRICS] §5.3）
 *
 * catalog の Object N が Metric Index N を説明し、data の Object N がその値を持つ。
 * Metric Index は 1 つの catalog version 内で resource 全体に一意であり、
 * data track ごとに振り直さない。一意性の検証は呼び出し側の責務である。
 *
 * 0 は Header / Capture Info 用、2^64-1 は data Group の End of Group Object ID が
 * 2^64 になり vi64 で表現できないため拒否する。
 *
 * `Publisher.sendObject` の `objectId` は number (0〜2^53-1) のため `Number()` で渡す。
 * data の Metric Index は End of Group の Object ID が `index + 1` になるため
 * `2^53-2` 以下、catalog の description は `2^53-1` 以下（group を End of Group で
 * 閉じる場合は `2^53-2` 以下）で送信できる。これを超える値は精度を保証しない
 * (送信層は `Number.isSafeInteger` を検査しない)。
 *
 * @param metricIndex Metric Index（1 以上 2^64-2 以下）
 * @throws Error metricIndex が bigint でない、または範囲外の場合
 */
export function metricObjectId(metricIndex: bigint): bigint {
  if (typeof metricIndex !== "bigint") {
    throw new Error(`metric index must be a bigint: ${describeType(metricIndex)}`);
  }
  if (metricIndex < 1n || metricIndex > MAX_VARINT - 1n) {
    throw new Error(`metric index must be 1..${MAX_VARINT - 1n}: ${metricIndex}`);
  }
  return metricIndex;
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
