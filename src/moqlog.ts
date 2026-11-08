/**
 * MOQ Log (moqlog) track payload
 * draft-jennings-moq-log-04 ([MOQLOG]) / draft-ietf-moq-msf-01 §9 (Log track)
 *
 * msf-01 §9.1 は Log track の payload を旧 log-03 §4 の JSON 形式と定めている。
 * 本モジュールは log-04 §5.3 のバイナリ Log Record に従う。各 MOQT Object は
 * 1 つの Log Record を含み、1 秒を 1 Group とする。
 *
 * 注意（MSF-01 との不一致）:
 * - msf-01 §9.1 は旧 log-03 §4 の JSON 形式を参照している。
 * - msf-01 §9.3 はマイクロ秒 62-bit の Group ID を MSF 自身が定義している。
 * - log-04 §5.2 は Group ID を Unix epoch 秒、§5.3 は payload をバイナリ Log Record と定める。
 * 本モジュールは log-04 に従い、MSF-01 の旧契約とは一致しない。名前は最新の companion draft に
 * 移行済みである。log-04 は Internet-Draft であり、改版で節番号・規則が変わる可能性がある。
 *
 * 注意（track naming）:
 * namespace / track name は旧 log-03 §3 ではなく moq-log-04 §5.1 に従う。
 * MSF-01 §9.2 は旧 log-03 を参照しており "TODO: Finalize on track naming" のままである。
 *
 * Group / Object の構成（§5.2）:
 * - 1 秒を 1 Group とし、Subgroup 0 の 1 本にまとめる。Datagram は使わない。
 * - ログの無い秒には Group を作らない。
 * - Object ID は Group 内で連続するため、PRIOR_OBJECT_ID_GAP は使わない。
 * - 最終ログの次の Object ID を End of Group とし、空 payload・properties なしで送る。
 * - 前の Group が既知なら Object 0 に PRIOR_GROUP_ID_GAP を付ける（差 - 1）。
 *
 * 推奨 Track Properties（§5.4 / §5.5）:
 * DEFAULT_PUBLISHER_PRIORITY は 128〜240、DEFAULT_PUBLISHER_GROUP_ORDER は Ascending、
 * MAX_CACHE_DURATION は保持期間、OBJECT_DELIVERY_TIMEOUT は高レベル向けの破棄時間。
 * 発見・購読は §5.6 に従う。過去ログの FETCH は、時間範囲 [T1, T2] を Location filter の
 * {T1, 0}〜{T2, max} に対応させる。fill は Next Object 開始の Location filter と
 * FILL_PARAMETERS を使う（§5.7）。
 */

import { concatUint8Arrays } from "./bytes";
import { ProtocolViolationError, SessionErrorCode } from "./error";
import {
  observabilityNamespaceTemplate,
  observabilityTrackName,
  observabilityTrackNamespace,
  SYSLOG_LEVELS,
} from "./observability";
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

/**
 * Log Record の Attribute（[MOQLOG] §5.3）
 *
 * Key / Value は UTF-8 文字列である。配列の順序と重複キーを保持する。
 */
export interface LogAttribute {
  key: string;
  value: string;
}

/**
 * Log Record（[MOQLOG] §5.3）
 *
 * Hostname / App Name / Proc ID / Msg ID は ASCII、Message / Attribute は UTF-8。
 * 空文字は [RFC5424] の NILVALUE を表す。severity は Track Name にあり、
 * payload へ重複して格納しない。
 */
export interface LogRecord {
  /**
   * Group の秒に足すナノ秒（0 以上 10^9 未満）
   *
   * 絶対ナノ秒時刻 t では group = t / 1_000_000_000n、
   * timestampOffset = t % 1_000_000_000n。マイクロ秒時刻 m では
   * group = m / 1_000_000n、timestampOffset = (m % 1_000_000n) * 1000n。
   */
  timestampOffset: bigint;
  /** [RFC5424] facility（0-23） */
  facility: number;
  /** [RFC5424] HOSTNAME（ASCII、空文字は NILVALUE） */
  hostname: string;
  /** [RFC5424] APP-NAME（ASCII、空文字は NILVALUE） */
  appName: string;
  /** [RFC5424] PROCID（ASCII、空文字は NILVALUE） */
  procId: string;
  /** [RFC5424] MSGID（ASCII、空文字は NILVALUE） */
  msgId: string;
  /** [RFC5424] MSG（UTF-8） */
  message: string;
  /** [RFC5424] structured data（UTF-8 の key-value、順序と重複を保持） */
  attributes: readonly LogAttribute[];
}

const LOG_LABEL = "moqlog";

function encodeAscii(value: string, field: string): Uint8Array {
  return encodeAsciiShared(value, LOG_LABEL, field);
}

function encodeUtf8(value: string, field: string): Uint8Array {
  return encodeUtf8Shared(value, LOG_LABEL, field);
}

function decodeAscii(data: Uint8Array, field: string): string {
  return decodeAsciiShared(data, LOG_LABEL, field);
}

function decodeUtf8(data: Uint8Array, field: string): string {
  return decodeUtf8Shared(data, LOG_LABEL, field);
}

function readVarint(data: Uint8Array, cursor: DecodeCursor, field: string): bigint {
  return readVarintShared(data, cursor, LOG_LABEL, field);
}

function readBytes(
  data: Uint8Array,
  cursor: DecodeCursor,
  length: bigint,
  field: string,
): Uint8Array {
  return readBytesShared(data, cursor, length, LOG_LABEL, field);
}

/**
 * Timestamp Offset の上限（10^9 未満）
 *
 * [MOQLOG] §5.3: Group の秒に足すナノ秒は 1000000000 未満。
 */
const MAX_TIMESTAMP_OFFSET = 1_000_000_000n;

/** [RFC5424] facility の上限 */
const MAX_FACILITY = 23;

/**
 * Log Record を Object Payload バイト列にエンコードする（[MOQLOG] §5.3）
 *
 * @throws Error 値域・ASCII の違反、文字列でないフィールドの場合
 */
export function encodeLogRecord(record: LogRecord): Uint8Array {
  if (typeof record !== "object" || record === null) {
    throw new Error(`moqlog record must be an object: ${describeType(record)}`);
  }
  if (typeof record.timestampOffset !== "bigint") {
    throw new Error(
      `moqlog timestampOffset must be a bigint: ${describeType(record.timestampOffset)}`,
    );
  }
  if (record.timestampOffset < 0n || record.timestampOffset >= MAX_TIMESTAMP_OFFSET) {
    throw new Error(
      `moqlog timestampOffset must be 0..${MAX_TIMESTAMP_OFFSET - 1n}: ${record.timestampOffset}`,
    );
  }
  if (!Number.isInteger(record.facility) || record.facility < 0 || record.facility > MAX_FACILITY) {
    throw new Error(`moqlog facility must be an integer 0-${MAX_FACILITY}: ${record.facility}`);
  }
  if (!Array.isArray(record.attributes)) {
    throw new Error(`moqlog attributes must be an array: ${describeType(record.attributes)}`);
  }

  const parts: Uint8Array[] = [
    encodeVarint(record.timestampOffset),
    encodeVarint(record.facility),
    encodeLengthPrefixed(encodeAscii(record.hostname, "hostname")),
    encodeLengthPrefixed(encodeAscii(record.appName, "appName")),
    encodeLengthPrefixed(encodeAscii(record.procId, "procId")),
    encodeLengthPrefixed(encodeAscii(record.msgId, "msgId")),
    encodeLengthPrefixed(encodeUtf8(record.message, "message")),
    encodeVarint(record.attributes.length),
  ];
  for (const [index, attribute] of record.attributes.entries()) {
    if (typeof attribute !== "object" || attribute === null) {
      throw new Error(`moqlog attributes[${index}] must be an object: ${describeType(attribute)}`);
    }
    parts.push(
      encodeLengthPrefixed(encodeUtf8(attribute.key, `attributes[${index}].key`)),
      encodeLengthPrefixed(encodeUtf8(attribute.value, `attributes[${index}].value`)),
    );
  }
  return concatUint8Arrays(parts);
}

/**
 * Object Payload バイト列を Log Record にデコードする（[MOQLOG] §5.3）
 *
 * 定義済みフィールドの後のバイトは将来拡張として無視する。
 *
 * @throws IncompleteDataError データが切り詰められている場合。
 * 完全な Object Payload を期待する呼び出し側は MALFORMED_OBJECT へ変換する
 * @throws ProtocolViolationError 値域・ASCII / UTF-8・長さの違反がある場合。
 * code は MALFORMED_OBJECT
 */
export function decodeLogRecord(data: Uint8Array): LogRecord {
  const cursor: DecodeCursor = { offset: 0 };
  const timestampOffset = readVarint(data, cursor, "timestamp offset");
  if (timestampOffset >= MAX_TIMESTAMP_OFFSET) {
    throw new ProtocolViolationError(
      `invalid moqlog timestampOffset: ${timestampOffset} must be less than ${MAX_TIMESTAMP_OFFSET}`,
      SessionErrorCode.MALFORMED_OBJECT,
    );
  }
  const facilityValue = readVarint(data, cursor, "facility");
  if (facilityValue > BigInt(MAX_FACILITY)) {
    throw new ProtocolViolationError(
      `invalid moqlog facility: ${facilityValue} must be 0-${MAX_FACILITY}`,
      SessionErrorCode.MALFORMED_OBJECT,
    );
  }
  const hostname = decodeAscii(
    readBytes(data, cursor, readVarint(data, cursor, "hostname length"), "hostname"),
    "hostname",
  );
  const appName = decodeAscii(
    readBytes(data, cursor, readVarint(data, cursor, "appName length"), "appName"),
    "appName",
  );
  const procId = decodeAscii(
    readBytes(data, cursor, readVarint(data, cursor, "procId length"), "procId"),
    "procId",
  );
  const msgId = decodeAscii(
    readBytes(data, cursor, readVarint(data, cursor, "msgId length"), "msgId"),
    "msgId",
  );
  const message = decodeUtf8(
    readBytes(data, cursor, readVarint(data, cursor, "message length"), "message"),
    "message",
  );
  const attributeCount = readVarint(data, cursor, "attribute count");
  const attributes: LogAttribute[] = [];
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
  return {
    timestampOffset,
    facility: Number(facilityValue),
    hostname,
    appName,
    procId,
    msgId,
    message,
    attributes,
  };
}

/**
 * syslog severity の文字列 ↔ 優先度（0-7）の対応
 *
 * moq-log-04 §5.1 / moq-metrics-03 §5.2 と [RFC5424] の規約に従う。
 * 実体は MOQMETRICS の granularity level と共通の表 (./observability)。
 */
export const LOG_SEVERITY_LEVELS: Readonly<Record<string, number>> = SYSLOG_LEVELS;

/**
 * Log Record の Group ID を計算する（[MOQLOG] §5.2）
 *
 * Group ID は Unix epoch からの秒（マイクロ秒入力を 1_000_000 で切り捨てる）。
 * 負数と 2^64-1 (`MAX_VARINT`) を超える結果を拒否する。
 *
 * `Publisher.sendObject` の `groupId` は number のため `Number()` で渡す。
 * 2^53 以上は精度を保証しない。
 *
 * @param timestampMicros Unix epoch からのマイクロ秒（非負）
 * @throws Error timestampMicros が bigint でない、負、または結果が vi64 の範囲外の場合
 */
export function logGroupId(timestampMicros: bigint): bigint {
  if (typeof timestampMicros !== "bigint") {
    throw new Error(`log timestamp must be a bigint: ${describeType(timestampMicros)}`);
  }
  if (timestampMicros < 0n) {
    throw new Error(`log timestamp must be non-negative: ${timestampMicros}`);
  }
  const groupId = timestampMicros / 1_000_000n;
  if (groupId > MAX_VARINT) {
    throw new Error(`log group ID exceeds varint maximum: ${groupId} > ${MAX_VARINT}`);
  }
  return groupId;
}

/**
 * Log Record の Object ID を計算する（[MOQLOG] §5.2）
 *
 * Object ID はその秒の 0 始まりの生成順である。End of Group は
 * 最終ログの Object ID + 1 にする。`Publisher.sendObject` へ渡すときは
 * number の安全整数の範囲で `Number()` に変換する。
 *
 * @param sequenceInSecond 同一秒内の 0 始まり連番
 * @throws Error sequenceInSecond が非負の安全な整数でない場合
 */
export function logObjectId(sequenceInSecond: number): bigint {
  if (!Number.isSafeInteger(sequenceInSecond) || sequenceInSecond < 0) {
    throw new Error(`log object sequence must be a non-negative safe integer: ${sequenceInSecond}`);
  }
  return BigInt(sequenceInSecond);
}

/**
 * 前の Group からの Prior Group ID Gap を計算する（[MOQLOG] §5.2）
 *
 * 前の Group が不明な場合（開始後最初の Group など）は undefined を返す。
 * それ以外は `currentGroupId - previousGroupId - 1n` を返す（0 を含む）。
 *
 * @param previousGroupId 前の Group ID（不明なら undefined）
 * @param currentGroupId 現在の Group ID
 * @throws Error 負数、vi64 の範囲外、増加しない Group ID の場合
 */
export function logPriorGroupIdGap(
  previousGroupId: bigint | undefined,
  currentGroupId: bigint,
): bigint | undefined {
  if (typeof currentGroupId !== "bigint") {
    throw new Error(`log group ID must be a bigint: ${describeType(currentGroupId)}`);
  }
  if (currentGroupId < 0n || currentGroupId > MAX_VARINT) {
    throw new Error(`log group ID must be 0..${MAX_VARINT}: ${currentGroupId}`);
  }
  if (previousGroupId === undefined) {
    return undefined;
  }
  if (typeof previousGroupId !== "bigint") {
    throw new Error(`previous log group ID must be a bigint: ${describeType(previousGroupId)}`);
  }
  if (previousGroupId < 0n || previousGroupId > MAX_VARINT) {
    throw new Error(`previous log group ID must be 0..${MAX_VARINT}: ${previousGroupId}`);
  }
  if (currentGroupId <= previousGroupId) {
    throw new Error(
      `log group ID must increase: previous ${previousGroupId}, current ${currentGroupId}`,
    );
  }
  return currentGroupId - previousGroupId - 1n;
}

/**
 * Log track の Track Namespace の固定 2 field（moq-log-04 §5.1）
 *
 * 実際の Track Namespace は ("logs.moq.arpa", "v1", <resourceID>) の 3 field。
 */
export const MOQLOG_NAMESPACE_PREFIX = Object.freeze(["logs.moq.arpa", "v1"] as const);

/**
 * Log track の Track Namespace タプルを構築する（moq-log-04 §5.1）
 *
 * resourceID は 16 桁の小文字 hexadecimal ASCII である。
 *
 * @param resourceId - 16 桁の小文字 hexadecimal ASCII の resource ID
 * @throws Error resourceId が 16 桁小文字 hexadecimal でない場合
 */
export function logTrackNamespace(resourceId: string): [string, string, string] {
  return observabilityTrackNamespace(MOQLOG_NAMESPACE_PREFIX, resourceId, "moqlog");
}

/**
 * Log track の MSF publishTracks 用 namespace テンプレート（moq-log-04 §6）
 *
 * `logs.2emoq.2earpa-v1-%resourceId%` を返す。利用者は `%resourceId%` を
 * 16 桁の小文字 hexadecimal に置換する。
 */
export const MOQLOG_NAMESPACE_TEMPLATE = observabilityNamespaceTemplate(MOQLOG_NAMESPACE_PREFIX);

/**
 * Log track の Track Name を構築する（moq-log-04 §5.1）
 *
 * Track Name は log priority level を表す ASCII 数字 1 バイト
 * （0=Emergency - 7=Debug）。
 *
 * @param severityLevel syslog 優先度（0-7）
 * @throws Error severityLevel が 0-7 の整数でない場合
 */
export function logTrackName(severityLevel: number): Uint8Array {
  return observabilityTrackName(severityLevel, "log priority");
}
