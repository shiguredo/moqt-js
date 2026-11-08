/**
 * MOQ Metrics (moqmetrics) track payload
 * draft-jennings-moq-metrics-03 ([MOQMETRICS]) / draft-ietf-moq-msf-01 §10 (Metrics track)
 *
 * msf-01 §10.1 は Metrics track の payload を [MOQMETRICS] Section 3 の形式と定めている（MUST）が、
 * これは旧版を参照している。本モジュールは metrics-03 §5.3 の catalog と §5.4 のバイナリ
 * Capture Info / Metric Value に従う。msf-01 §10.1 が参照する旧版の JSON 形式と §10.3 の
 * Object 0 の timestamp / attributes は旧契約であり、本実装とは一致しない。
 *
 * catalog:
 * - catalog track は Resource Attributes と Metric Description を保持し、Subgroup delivery を使う（MUST）。
 * - Group ID は catalog version（1 始まり）であり、Header の format Version とは別である。
 * - Object 0 が Header、Object N が Metric Index N の Description である。
 * - data Object N の解釈には、参照する catalog version の Object N だけが必要である。
 * 全 catalog や前の data Group を参照しない。catalog を data より先に送る（MUST）。
 * - catalog の MAX_CACHE_DURATION は全 data track より短くせず、DEFAULT_PUBLISHER_PRIORITY は
 * 全 data track より数値を小さくし、OBJECT_DELIVERY_TIMEOUT を付けない。MSF publishTracks で
 * data を配信する場合も、同じ namespace の catalog を同じ connectionUri / token で公開する。
 *
 * data track:
 * - Object 0 は MetricsCaptureInfo（timestampOffset / catalogVersion）。
 * - Object N は catalog の Object N の MetricDescription に従う MetricValue。
 * - 1 Group は Subgroup 0 の 1 本にまとめ、Datagram を使わない。Object 0 を先頭に送ることは
 * 呼び出し側の責務であり、このモジュールは強制しない。
 * - 各 Group の Object 0 に PRIOR_GROUP_ID_GAP（前の capture からのミリ秒差 - 1）を付ける。
 * 前の capture が不明なら付けない。skip された Object ID の次の Object に
 * PRIOR_OBJECT_ID_GAP（skip 数）を付ける。
 * - End of Group は最大 Object ID + 1 を、空 payload・properties なし・END_OF_GROUP で送る。
 * - data Object の解釈には、同じ catalog version の同じ Object ID の Description だけが必要で、
 * 全 catalog や前の data Group を必要としない。
 *
 * Group ID:
 * - data track の Group ID は Unix epoch ミリ秒（0 以上 2^64-1 以下）。62-bit truncate はしない。
 * - catalog の Group ID は catalog version であり、ミリ秒ではない。
 *
 * Track Properties / Object ID filter:
 * - data track の DEFAULT_PUBLISHER_PRIORITY は §5.2 の 128〜240、
 * DEFAULT_PUBLISHER_GROUP_ORDER は Ascending、MAX_CACHE_DURATION と
 * OBJECT_DELIVERY_TIMEOUT を設定する（§5.5 / §5.6）。
 * - Object ID filter は Object 0 を含める MUST とし、同じ filter を catalog track にも適用する。
 * Range Filter は relay の MAX_FILTER_RANGES が 0 でも処理できる最適化として扱う。
 * - discovery / subscription は §5.7 に従う。未取得 catalog version の FETCH は利用者の責務であり、
 * 自動購読基盤は提供しない。
 * - FETCH / fill は §5.9 の時間範囲を Location filter に対応させる。FETCH 応答では Object Status が
 * 運ばれないため、存在しない Object の表現は transport の仕様に従う。
 *
 * Metric Index:
 * - 1 つの catalog version 内で resource 全体に一意であり、data track ごとに振り直さない。
 * - 複数の data track は同じ version の同じ Index を同じ metric として参照する。
 * - 新しい version では再割当してよい（MAY）が、Object ID filter を保つため可能な限り
 * 同じ Index を維持する（SHOULD）。
 *
 * 注意（draft）:
 * metrics-03 は Internet-Draft であり、改版で節番号・規則が変わる可能性がある。
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
import { endOfGroupObjectId, priorGroupIdGap, priorObjectIdGap } from "./observabilityGap";
import { encodeVarint, MAX_VARINT } from "./varint";
import {
  observabilityNamespaceTemplate,
  observabilityTrackName,
  observabilityTrackNamespace,
  SYSLOG_LEVELS,
} from "./observability";
import { CATALOG_TRACK_NAME } from "./msf/version";

/**
 * Object 0 の payload（[MOQMETRICS] §5.4）
 *
 * timestampOffset は Group のミリ秒に足すナノ秒で、絶対ナノ秒は
 * groupId × 1_000_000 + timestampOffset。catalogVersion は catalog の Group ID。
 */
export interface MetricsCaptureInfo {
  /**
   * Group のミリ秒に足すナノ秒（0 以上 10^6 未満）
   *
   * 絶対ナノ秒は groupId × 1_000_000 + timestampOffset で求める。
   */
  timestampOffset: bigint;
  /** catalog の Group ID（1 以上 2^64-1 以下）。Header の format Version とは別 */
  catalogVersion: bigint;
}

/**
 * data Object N の Metric Value（[MOQMETRICS] §5.4）
 *
 * unsigned / signed は bigint、float は number。どの表現かは catalog の
 * MetricDescription の valueRepresentation で決まる。
 */
export type MetricValue = bigint | number;

/**
 * catalog の Resource Attribute（[MOQMETRICS] §5.3）
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

/** Timestamp Offset の上限（10^6 未満） */
const MAX_CAPTURE_TIMESTAMP_OFFSET = 1_000_000n;

/** signed 64-bit の下限 */
const SIGNED_INT64_MIN = -(1n << 63n);

/** signed 64-bit の上限 */
const SIGNED_INT64_MAX = (1n << 63n) - 1n;

/**
 * signed 64-bit を network byte order の 8 バイトにする
 */
function encodeSignedInt64(value: bigint): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigInt64(0, value, false);
  return bytes;
}

/**
 * IEEE 754 binary64 を network byte order の 8 バイトにする
 */
function encodeFloat64(value: number): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setFloat64(0, value, false);
  return bytes;
}

/**
 * Capture Info を Object Payload バイト列にエンコードする（[MOQMETRICS] §5.4）
 *
 * @throws Error timestampOffset が 0..999999 でない、catalogVersion が 1..2^64-1 でない場合
 */
export function encodeMetricsCaptureInfo(info: MetricsCaptureInfo): Uint8Array {
  if (typeof info !== "object" || info === null) {
    throw new Error(`moqmetrics capture info must be an object: ${describeType(info)}`);
  }
  if (typeof info.timestampOffset !== "bigint") {
    throw new Error(
      `moqmetrics capture timestampOffset must be a bigint: ${describeType(info.timestampOffset)}`,
    );
  }
  if (info.timestampOffset < 0n || info.timestampOffset >= MAX_CAPTURE_TIMESTAMP_OFFSET) {
    throw new Error(
      `moqmetrics capture timestampOffset must be 0..${MAX_CAPTURE_TIMESTAMP_OFFSET - 1n}: ${info.timestampOffset}`,
    );
  }
  if (typeof info.catalogVersion !== "bigint") {
    throw new Error(
      `moqmetrics capture catalogVersion must be a bigint: ${describeType(info.catalogVersion)}`,
    );
  }
  if (info.catalogVersion < 1n || info.catalogVersion > MAX_VARINT) {
    throw new Error(
      `moqmetrics capture catalogVersion must be 1..${MAX_VARINT}: ${info.catalogVersion}`,
    );
  }
  return concatUint8Arrays([encodeVarint(info.timestampOffset), encodeVarint(info.catalogVersion)]);
}

/**
 * Capture Info を Object Payload バイト列からデコードする（[MOQMETRICS] §5.4）
 *
 * 2 フィールドを読んだ後の末尾は将来拡張として無視する。§5.4 に明文はないが、
 * §5.3 の将来拡張規則を Capture Info にも適用する本実装の方針である。
 *
 * @throws IncompleteDataError データが切り詰められている場合
 * @throws ProtocolViolationError 値域の違反がある場合。code は MALFORMED_OBJECT
 */
export function decodeMetricsCaptureInfo(data: Uint8Array): MetricsCaptureInfo {
  const cursor: DecodeCursor = { offset: 0 };
  const timestampOffset = readVarint(data, cursor, "capture timestamp offset");
  if (timestampOffset >= MAX_CAPTURE_TIMESTAMP_OFFSET) {
    throw new ProtocolViolationError(
      `invalid moqmetrics capture timestampOffset: ${timestampOffset} must be less than ${MAX_CAPTURE_TIMESTAMP_OFFSET}`,
      SessionErrorCode.MALFORMED_OBJECT,
    );
  }
  const catalogVersion = readVarint(data, cursor, "capture catalog version");
  if (catalogVersion < 1n) {
    throw new ProtocolViolationError(
      `invalid moqmetrics capture catalogVersion: ${catalogVersion} must be at least 1`,
      SessionErrorCode.MALFORMED_OBJECT,
    );
  }
  return { timestampOffset, catalogVersion };
}

/**
 * Metric Value を Object Payload バイト列にエンコードする（[MOQMETRICS] §5.4）
 *
 * unsigned は 0..2^64-1 の vi64、signed は -2^63..2^63-1 の 8 バイト、
 * float は IEEE 754 binary64 の 8 バイト。表現と値の型が一致しなければ拒否する。
 *
 * @throws Error 表現と値の型・範囲が一致しない場合
 */
export function encodeMetricValue(description: MetricDescription, value: MetricValue): Uint8Array {
  if (typeof description !== "object" || description === null) {
    throw new Error(
      `moqmetrics metric description must be an object: ${describeType(description)}`,
    );
  }
  switch (description.valueRepresentation) {
    case "unsigned": {
      if (typeof value !== "bigint") {
        throw new Error(
          `moqmetrics unsigned metric value must be a bigint: ${describeType(value)}`,
        );
      }
      if (value < 0n || value > MAX_VARINT) {
        throw new Error(`moqmetrics unsigned metric value must be 0..${MAX_VARINT}: ${value}`);
      }
      return encodeVarint(value);
    }
    case "signed": {
      if (typeof value !== "bigint") {
        throw new Error(`moqmetrics signed metric value must be a bigint: ${describeType(value)}`);
      }
      if (value < SIGNED_INT64_MIN || value > SIGNED_INT64_MAX) {
        throw new Error(
          `moqmetrics signed metric value must be ${SIGNED_INT64_MIN}..${SIGNED_INT64_MAX}: ${value}`,
        );
      }
      return encodeSignedInt64(value);
    }
    case "float": {
      if (typeof value !== "number") {
        throw new Error(`moqmetrics float metric value must be a number: ${describeType(value)}`);
      }
      return encodeFloat64(value);
    }
    default:
      throw new Error(
        `moqmetrics valueRepresentation must be unsigned, signed, or float: ${String(description.valueRepresentation)}`,
      );
  }
}

/**
 * Metric Value を Object Payload バイト列からデコードする（[MOQMETRICS] §5.4）
 *
 * unsigned は payload 全体が 1 つの vi64 でなければならない。signed / float は
 * 8 バイトでなければならない。
 *
 * @throws IncompleteDataError unsigned の vi64 が切り詰められている場合
 * @throws ProtocolViolationError 長さ・表現・余分なバイトの違反がある場合。
 * code は MALFORMED_OBJECT
 */
export function decodeMetricValue(
  description: MetricDescription,
  payload: Uint8Array,
): MetricValue {
  if (typeof description !== "object" || description === null) {
    throw new ProtocolViolationError(
      `moqmetrics metric description must be an object: ${describeType(description)}`,
      SessionErrorCode.MALFORMED_OBJECT,
    );
  }
  switch (description.valueRepresentation) {
    case "unsigned": {
      const cursor: DecodeCursor = { offset: 0 };
      const value = readVarint(payload, cursor, "unsigned metric value");
      if (cursor.offset !== payload.length) {
        throw new ProtocolViolationError(
          `invalid moqmetrics unsigned metric value: ${payload.length - cursor.offset} trailing bytes`,
          SessionErrorCode.MALFORMED_OBJECT,
        );
      }
      return value;
    }
    case "signed": {
      if (payload.length !== 8) {
        throw new ProtocolViolationError(
          `invalid moqmetrics signed metric value length: ${payload.length} must be 8`,
          SessionErrorCode.MALFORMED_OBJECT,
        );
      }
      return new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getBigInt64(
        0,
        false,
      );
    }
    case "float": {
      if (payload.length !== 8) {
        throw new ProtocolViolationError(
          `invalid moqmetrics float metric value length: ${payload.length} must be 8`,
          SessionErrorCode.MALFORMED_OBJECT,
        );
      }
      return new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getFloat64(
        0,
        false,
      );
    }
    default:
      throw new ProtocolViolationError(
        `invalid moqmetrics valueRepresentation: ${String(description.valueRepresentation)}`,
        SessionErrorCode.MALFORMED_OBJECT,
      );
  }
}

/**
 * data track の Group ID を計算する（[MOQMETRICS] §5.4 / draft-ietf-moq-msf-01 §10.3）
 *
 * Group ID は Unix epoch からのミリ秒をそのまま使う（62-bit truncate はしない）。
 * `Publisher.sendObject` の `groupId` は number (0〜2^53-1) のため `Number()` で渡す。
 * 2^53 以上は `Number()` で値が変わり得るため送信できない場合がある（精度を保証しない）。
 *
 * @param timestampMs Unix epoch からのミリ秒（0 以上 2^64-1 以下）
 * @throws Error timestampMs が bigint でない、または 0..2^64-1 の範囲外の場合
 */
export function metricsGroupId(timestampMs: bigint): bigint {
  if (typeof timestampMs !== "bigint") {
    throw new Error(`metrics timestamp must be a bigint: ${describeType(timestampMs)}`);
  }
  if (timestampMs < 0n || timestampMs > MAX_VARINT) {
    throw new Error(`metrics timestamp must be 0..${MAX_VARINT}: ${timestampMs}`);
  }
  return timestampMs;
}

/**
 * Object ID 0 は MetricsCaptureInfo（[MOQMETRICS] §5.4）
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
 * 前の Group からの Prior Group ID Gap を計算する（[MOQMETRICS] §5.4）
 *
 * 前の capture が不明な場合（開始後最初の Group など）は undefined を返す。
 * それ以外は `currentGroupId - previousGroupId - 1n` を返す（0 を含む）。
 *
 * @param previousGroupId 前の Group ID（不明なら undefined）
 * @param currentGroupId 現在の Group ID
 * @throws Error 負数、vi64 の範囲外、増加しない Group ID の場合
 */
export function metricsPriorGroupIdGap(
  previousGroupId: bigint | undefined,
  currentGroupId: bigint,
): bigint | undefined {
  return priorGroupIdGap(previousGroupId, currentGroupId, "metrics");
}

/**
 * skip された Object ID の Prior Object ID Gap を計算する（[MOQMETRICS] §5.4）
 *
 * 差が 1（skip なし）なら undefined、それ以外は skip 数を返す。
 *
 * @param previousObjectId 前の Object ID
 * @param currentObjectId 現在の Object ID
 * @throws Error 負数、vi64 の範囲外、増加しない Object ID の場合
 */
export function metricsPriorObjectIdGap(
  previousObjectId: bigint,
  currentObjectId: bigint,
): bigint | undefined {
  return priorObjectIdGap(previousObjectId, currentObjectId, "metrics");
}

/**
 * End of Group の Object ID を計算する（[MOQMETRICS] §5.4）
 *
 * 最大の Metric Object ID + 1 を返す。2^64 は vi64 で表現できないため、
 * 入力は 0 以上 2^64-2 以下に限る。`Publisher.sendObject` の `objectId` は
 * number (0〜2^53-1) のため、`Number()` で渡すと 2^53 以上は精度を保証しない。
 *
 * @param largestMetricObjectId 最大の Metric Object ID
 * @throws Error 0..2^64-2 の範囲外の場合
 */
export function metricsEndOfGroupObjectId(largestMetricObjectId: bigint): bigint {
  return endOfGroupObjectId(largestMetricObjectId, "metrics");
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
