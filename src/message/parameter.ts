/**
 * MOQT Parameter encoding/decoding
 * draft-ietf-moq-transport-19 Section 10.2 (Message Parameter)
 *
 * https://datatracker.ietf.org/doc/draft-ietf-moq-transport/
 *
 * Message Parameter {
 *   Type Delta (vi64),
 *   Value (..)
 * }
 *
 * Type Delta は前のパラメータの Type との差分。
 * 偶数型: varint 値
 * 奇数型: Length プレフィックス付きバイト列
 * draft-ietf-moq-transport-19 Section 1.4.3
 */

import { IncompleteDataError, InvalidFilterError, ProtocolViolationError } from "../error";
import { decodeVarint, encodeVarint, MAX_VARINT } from "../varint";
import { MessageParameterType, type Location } from "./types";

/**
 * Track Namespace / Full Track Name の最大サイズ（バイト）
 *
 * draft-ietf-moq-transport-19:
 * Track Namespace と Full Track Name は最大 4,096 バイト。
 * 超過時は PROTOCOL_VIOLATION でセッションを終了する。
 * draft-ietf-moq-transport-19 Section 2.4.1
 */
export const MAX_TRACK_NAMESPACE_SIZE = 4096;
export const MAX_TRACK_NAME_SIZE = 4096;
export const MAX_FULL_TRACK_NAME_SIZE = 4096;

/**
 * Full Track Name の合計長を検証する
 *
 * draft-ietf-moq-transport-19 §2.4.1:
 * Namespace 全フィールド長 + Track Name 長の合計が 4096 バイトを
 * 超えてはならない (MUST NOT)。
 *
 * @param namespace - TrackNamespace
 * @param trackName - Track Name (UTF-8 文字列)
 * @throws ProtocolViolationError 合計長が 4096 バイトを超える場合
 */
export function validateFullTrackName(namespace: TrackNamespace, trackName: string): void {
  let totalSize = new TextEncoder().encode(trackName).length;
  for (const field of namespace.tuple) {
    totalSize += field.length;
  }
  if (totalSize > MAX_FULL_TRACK_NAME_SIZE) {
    throw new ProtocolViolationError(
      `full track name exceeds maximum size: ${totalSize} > ${MAX_FULL_TRACK_NAME_SIZE}`,
    );
  }
}

/**
 * Full Track Name の合計長をワイヤバイト長で検証する
 *
 * draft-ietf-moq-transport-19 §2.4.1:
 * 「The length of a Full Track Name is computed as the sum of the Track
 *  Namespace Field Length fields and the Track Name Length field.」
 * Length フィールドの値のみを加算し、varint エンコードサイズは含まない。
 * 4,096 バイトちょうどは許容される。
 *
 * string ベースの validateFullTrackName は TextEncoder による再エンコードで
 * 長さを計測するため、不正な UTF-8 バイト列は TextDecoder の置換 (U+FFFD) で
 * 長さが水増しされ、誤って超過判定されたり、BOM 除去で短く計測されたりする。
 * デコード経路ではワイヤバイト長を直接加算する本関数を使用する。
 *
 * @param namespace - TrackNamespace
 * @param trackNameBytes - Track Name のワイヤバイト列
 * @throws ProtocolViolationError 合計長が 4096 バイトを超える場合
 */
export function validateFullTrackNameBytes(
  namespace: TrackNamespace,
  trackNameBytes: Uint8Array,
): void {
  let totalSize = trackNameBytes.length;
  for (const field of namespace.tuple) {
    totalSize += field.length;
  }
  if (totalSize > MAX_FULL_TRACK_NAME_SIZE) {
    throw new ProtocolViolationError(
      `full track name exceeds maximum size: ${totalSize} > ${MAX_FULL_TRACK_NAME_SIZE}`,
    );
  }
}

/**
 * Track Namespace の最大フィールド数
 *
 * draft-ietf-moq-transport-19 Section 10.18 (SUBSCRIBE_NAMESPACE):
 * "receives a Track Namespace Prefix consisting of greater than
 *  32 Track Namespace Fields, it MUST close the session with a
 *  PROTOCOL_VIOLATION."
 */
export const MAX_TRACK_NAMESPACE_FIELDS = 32;
/**
 * Reason Phrase の最大長 (バイト)
 *
 * draft-ietf-moq-transport-19 Section 1.4.4:
 * "The reason phrase length has a maximum value of 1024 bytes.
 *  If an endpoint receives a length exceeding the maximum,
 *  it MUST close the session with a PROTOCOL_VIOLATION"
 */
export const MAX_REASON_PHRASE_LENGTH = 1024;
/**
 * Key-Value-Pair の Value 最大長（バイト）
 *
 * draft-ietf-moq-transport-19 §1.4.3:
 * 「The maximum length of a value is 2^16-1 bytes. If an endpoint receives
 *  a length larger than the maximum, it MUST close the session with a
 *  PROTOCOL_VIOLATION.」
 */
const MAX_KVP_VALUE_LENGTH = 65535;

/**
 * MOQT Parameter
 *
 * 偶数タイプ: varint 値として解釈
 * 奇数タイプ: Length プレフィックス付きバイト列
 */
export interface Parameter {
  type: number;
  value: Uint8Array;
}

/**
 * パラメータをエンコードする
 */
export function encodeParameter(param: Parameter): Uint8Array {
  const typeBytes = encodeVarint(param.type);

  if (param.type % 2 === 1) {
    // 奇数型: Length プレフィックス付き
    const lengthBytes = encodeVarint(param.value.length);
    const result = new Uint8Array(typeBytes.length + lengthBytes.length + param.value.length);
    result.set(typeBytes, 0);
    result.set(lengthBytes, typeBytes.length);
    result.set(param.value, typeBytes.length + lengthBytes.length);
    return result;
  }

  // 偶数型: 値のみ
  const result = new Uint8Array(typeBytes.length + param.value.length);
  result.set(typeBytes, 0);
  result.set(param.value, typeBytes.length);
  return result;
}

/**
 * パラメータをデコードする
 * @returns [parameter, consumed bytes]
 */
export function decodeParameter(data: Uint8Array, offset = 0): [Parameter, number] {
  const [paramType, typeConsumed] = decodeVarint(data, offset);
  let totalConsumed = typeConsumed;

  let value: Uint8Array;

  if (Number(paramType) % 2 === 1) {
    // 奇数型: Length プレフィックス付き
    const [length, lengthConsumed] = decodeVarint(data, offset + totalConsumed);
    totalConsumed += lengthConsumed;
    if (Number(length) > MAX_KVP_VALUE_LENGTH) {
      throw new ProtocolViolationError(
        `parameter value length exceeds maximum: ${length} > ${MAX_KVP_VALUE_LENGTH}`,
      );
    }
    value = data.slice(offset + totalConsumed, offset + totalConsumed + Number(length));
    totalConsumed += Number(length);
  } else {
    // 偶数型: varint 値
    const [val, valConsumed] = decodeVarint(data, offset + totalConsumed);
    value = encodeVarint(val);
    totalConsumed += valConsumed;
  }

  return [{ type: Number(paramType), value }, totalConsumed];
}

/**
 * パラメータの varint 値を取得
 */
export function getParameterVarintValue(param: Parameter): bigint {
  const [value] = decodeVarint(param.value, 0);
  return value;
}

/**
 * パラメータから Location 値を取得
 *
 * LARGEST_OBJECT (0x09) パラメータなど、Location を含むパラメータ用
 * draft-ietf-moq-transport-19 Section 10.2.16 (LARGEST OBJECT Parameter)
 */
export function getParameterLocationValue(param: Parameter): Location {
  const [location] = decodeLocation(param.value, 0);
  return location;
}

/**
 * GROUP_ORDER パラメータの値を検証する
 *
 * draft-ietf-moq-transport-19 Section 10.2.8:
 * "The allowed values are Ascending (0x1) or Descending (0x2).
 *  If an endpoint receives a value outside this range, it MUST close
 *  the session with PROTOCOL_VIOLATION."
 */
export function validateGroupOrderValue(value: number): void {
  if (value !== 0x01 && value !== 0x02) {
    throw new ProtocolViolationError(
      `invalid GROUP_ORDER value: 0x${value.toString(16)}, expected 0x1 or 0x2`,
    );
  }
}

/**
 * FORWARD パラメータの値を検証する
 *
 * draft-ietf-moq-transport-19 Section 10.2.17:
 * "The allowed values are 0 (don't forward) or 1 (forward).
 *  If an endpoint receives a value outside this range, it MUST close
 *  the session with PROTOCOL_VIOLATION."
 */
export function validateForwardValue(value: number): void {
  if (value !== 0 && value !== 1) {
    throw new ProtocolViolationError(`invalid FORWARD value: ${value}, expected 0 or 1`);
  }
}

/**
 * uint8 型の Message Parameter Value をエンコードする
 *
 * draft-ietf-moq-transport-19 Section 10.2.7 / 10.2.8 / 10.2.12:
 * SUBSCRIBER_PRIORITY / GROUP_ORDER / FORWARD は varint ではなく uint8。
 */
export function encodeUint8ParameterValue(
  value: number | bigint,
  parameterName: string,
): Uint8Array {
  const numericValue = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isInteger(numericValue) || numericValue < 0 || numericValue > 0xff) {
    throw new Error(`invalid ${parameterName} value: ${numericValue}, expected 0..255`);
  }
  return new Uint8Array([numericValue]);
}

/**
 * Track Namespace (Section 2.4.1)
 */
export interface TrackNamespace {
  tuple: Uint8Array[];
}

/**
 * Track Namespace をエンコードする
 *
 * draft-ietf-moq-transport-19:
 * Track Namespace は最大 4,096 バイト。
 * draft-ietf-moq-transport-19 Section 2.4.1
 */
export function encodeTrackNamespace(namespace: TrackNamespace): Uint8Array {
  // 先にサイズをチェック
  let dataSize = 0;
  for (const element of namespace.tuple) {
    dataSize += element.length;
  }
  if (dataSize > MAX_TRACK_NAMESPACE_SIZE) {
    throw new Error(
      `track namespace exceeds maximum size: ${dataSize} > ${MAX_TRACK_NAMESPACE_SIZE}`,
    );
  }

  const parts: Uint8Array[] = [encodeVarint(namespace.tuple.length)];

  for (const element of namespace.tuple) {
    parts.push(encodeVarint(element.length));
    parts.push(element);
  }

  // 結合
  const totalLength = parts.reduce((sum, p) => sum + p.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

/**
 * Track Namespace をデコードする
 *
 * draft-ietf-moq-transport-19:
 * Track Namespace は最大 4,096 バイト。
 * draft-ietf-moq-transport-19 Section 2.4.1
 *
 * @returns [namespace, consumed bytes]
 */
export function decodeTrackNamespace(data: Uint8Array, offset = 0): [TrackNamespace, number] {
  const [numElements, consumed] = decodeVarint(data, offset);
  let totalConsumed = consumed;

  // draft-ietf-moq-transport-19 Section 10.18 (SUBSCRIBE_NAMESPACE):
  // フィールド数が 32 を超える場合は PROTOCOL_VIOLATION
  if (Number(numElements) > MAX_TRACK_NAMESPACE_FIELDS) {
    throw new ProtocolViolationError(
      `track namespace fields exceeds maximum: ${numElements} > ${MAX_TRACK_NAMESPACE_FIELDS}`,
    );
  }

  const elements: Uint8Array[] = [];
  let dataSize = 0;

  for (let i = 0; i < Number(numElements); i++) {
    const [elemLen, lenConsumed] = decodeVarint(data, offset + totalConsumed);
    totalConsumed += lenConsumed;
    // draft-ietf-moq-transport-19 Section 2.4.1:
    // "Each Track Namespace Field Value MUST contain at least one byte.
    //  If an endpoint receives a Track Namespace Field with a Track
    //  Namespace Field Length of 0, it MUST close the session with a
    //  PROTOCOL_VIOLATION."
    if (elemLen === 0n) {
      throw new ProtocolViolationError("track namespace field length is zero");
    }
    const element = data.slice(offset + totalConsumed, offset + totalConsumed + Number(elemLen));
    elements.push(element);
    totalConsumed += Number(elemLen);
    dataSize += Number(elemLen);
  }

  if (dataSize > MAX_TRACK_NAMESPACE_SIZE) {
    throw new ProtocolViolationError(
      `track namespace exceeds maximum size: ${dataSize} > ${MAX_TRACK_NAMESPACE_SIZE}`,
    );
  }

  return [{ tuple: elements }, totalConsumed];
}

/**
 * string[] から TrackNamespace を作成
 *
 * draft-ietf-moq-transport-19:
 * Track Namespace は最大 4,096 バイト。
 * draft-ietf-moq-transport-19 Section 2.4.1
 */
export function createTrackNamespace(parts: string[]): TrackNamespace {
  const encoder = new TextEncoder();
  const tuple = parts.map((p) => encoder.encode(p));

  // draft-ietf-moq-transport-19 Section 2.4.1:
  // "Each Track Namespace Field Value MUST contain at least one byte."
  let dataSize = 0;
  for (const element of tuple) {
    if (element.length === 0) {
      throw new Error("track namespace field length is zero");
    }
    dataSize += element.length;
  }
  if (dataSize > MAX_TRACK_NAMESPACE_SIZE) {
    throw new Error(
      `track namespace exceeds maximum size: ${dataSize} > ${MAX_TRACK_NAMESPACE_SIZE}`,
    );
  }

  return { tuple };
}

/**
 * TrackNamespace を string[] に変換
 */
export function trackNamespaceToStrings(namespace: TrackNamespace): string[] {
  const decoder = new TextDecoder();
  return namespace.tuple.map((t) => decoder.decode(t));
}

/**
 * Track Namespace が session-level かを判定する
 *
 * draft-ietf-moq-transport-19 §3.2.2 (Session-Level Tracks):
 * "MOQT defines the .session namespace ... in the first position of
 *  the Track Namespace for session-level tracks and namespaces."
 */
function isSessionLevelNamespace(tuple: Uint8Array[]): boolean {
  if (tuple.length === 0 || tuple[0].length === 0) return false;
  if (tuple[0][0] !== 0x2e) return false;
  const decoder = new TextDecoder();
  return decoder.decode(tuple[0]) === ".session";
}

/**
 * 受信した Track Namespace を DOES_NOT_EXIST で拒否すべきかを判定する
 *
 * draft-ietf-moq-transport-19 §3.2.1 (Reserved Namespaces):
 * "A Track Namespace whose first field is exactly . (a single period,
 *  0x2e) is reserved and MUST NOT be used for any purpose; endpoints
 *  MUST NOT publish tracks or namespaces under it and MUST reject
 *  requests referencing it with DOES_NOT_EXIST."
 * draft-ietf-moq-transport-19 §3.2.2 (Session-Level Tracks and Namespaces):
 * "An endpoint that receives a request for an unrecognized session-level
 *  track or namespace MUST reject it with REQUEST_ERROR using error code
 *  DOES_NOT_EXIST rather than passing it to the Application."
 *
 * 拒否対象は "." 単体と ".session" のみに限定する。それ以外の予約
 * 名前空間 (例: ".foo") は §3.2.1 の "an endpoint that receives a
 * request for an unrecognized reserved namespace MUST pass it to the
 * Application" により拒否せずアプリへ渡す (送信側の ". で始まる
 * すべてを拒否する方針 (validateTrackNamespaceForSend) は受信側には
 * 持ち込まない)。
 *
 * 将来 .session 配下の既知の track を実装する場合、§3.2.2 の拒否 MUST
 * は "unrecognized" な session-level track / namespace に限定される
 * ため、本関数を namespace 単位の全拒否から track 単位の認識判定へ
 * 緩和すること。
 */
export function isRejectedReceiveNamespace(tuple: Uint8Array[]): boolean {
  if (tuple.length === 0) return false;
  // "." 単体 (0x2e 1 バイトのみ) は §3.2.1 により MUST 拒否
  if (tuple[0].length === 1 && tuple[0][0] === 0x2e) return true;
  // 先頭フィールドが .session なら §3.2.2 により MUST 拒否。
  // 本関数は namespace のみで判定し、Track Name は判定に使わないため、
  // Track Name が空でも非空でも拒否対象になる (空 Track Name の MUST 拒否を包含)。
  return isSessionLevelNamespace(tuple);
}

/**
 * Track Name をエンコードする（サイズ検証付き）
 *
 * draft-ietf-moq-transport-19:
 * Full Track Name は最大 4,096 バイト。
 * draft-ietf-moq-transport-19 Section 2.4.1
 */
export function encodeTrackName(trackName: string): Uint8Array {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(trackName);

  if (bytes.length > MAX_TRACK_NAME_SIZE) {
    throw new Error(`track name exceeds maximum size: ${bytes.length} > ${MAX_TRACK_NAME_SIZE}`);
  }

  return bytes;
}

/**
 * Track Name のサイズを検証する
 *
 * draft-ietf-moq-transport-19:
 * Full Track Name は最大 4,096 バイト。
 * draft-ietf-moq-transport-19 Section 2.4.1
 */
export function validateTrackNameSize(trackNameBytes: Uint8Array): void {
  if (trackNameBytes.length > MAX_TRACK_NAME_SIZE) {
    throw new Error(
      `track name exceeds maximum size: ${trackNameBytes.length} > ${MAX_TRACK_NAME_SIZE}`,
    );
  }
}

/**
 * Location をエンコードする
 */
export function encodeLocation(location: Location): Uint8Array {
  const groupBytes = encodeVarint(location.group);
  const objectBytes = encodeVarint(location.object);
  const result = new Uint8Array(groupBytes.length + objectBytes.length);
  result.set(groupBytes, 0);
  result.set(objectBytes, groupBytes.length);
  return result;
}

/**
 * Location をデコードする
 * @returns [location, consumed bytes]
 */
export function decodeLocation(data: Uint8Array, offset = 0): [Location, number] {
  const [group, groupConsumed] = decodeVarint(data, offset);
  const [object, objectConsumed] = decodeVarint(data, offset + groupConsumed);
  return [{ group, object }, groupConsumed + objectConsumed];
}

/**
 * 単一のパラメータを delta encoding でエンコードする
 *
 * draft-ietf-moq-transport-19 Section 1.4.3 (Key-Value-Pair Structure):
 * https://www.ietf.org/archive/id/draft-ietf-moq-transport-19.html#section-1.4.3
 * Key-Value-Pairs encode a Type value as a delta from the previous Type value,
 * or from 0 if there is no previous Type value.
 *
 * @param param - エンコードするパラメータ
 * @param previousType - 前のパラメータの Type 値（最初のパラメータの場合は 0）
 * @returns エンコードされたバイト列
 */
function encodeKeyValuePair(param: Parameter, previousType: number): Uint8Array {
  const deltaType = param.type - previousType;
  if (deltaType < 0) {
    throw new Error(
      `delta type must be non-negative: current type=${param.type}, previous type=${previousType}`,
    );
  }

  const deltaBytes = encodeVarint(deltaType);

  if (param.type % 2 === 1) {
    // 奇数型: Length プレフィックス付き
    const lengthBytes = encodeVarint(param.value.length);
    const result = new Uint8Array(deltaBytes.length + lengthBytes.length + param.value.length);
    result.set(deltaBytes, 0);
    result.set(lengthBytes, deltaBytes.length);
    result.set(param.value, deltaBytes.length + lengthBytes.length);
    return result;
  }

  // 偶数型: 値のみ
  const result = new Uint8Array(deltaBytes.length + param.value.length);
  result.set(deltaBytes, 0);
  result.set(param.value, deltaBytes.length);
  return result;
}

/**
 * Key-Value-Pair を 1 つデコードする
 *
 * @param data - デコード対象データ
 * @param offset - 開始オフセット
 * @param previousType - 前のパラメータの Type 値（最初のパラメータの場合は 0）
 * @returns [parameter, consumed bytes, paramType (bigint)]
 *          paramType は次のパラメータの previousType に使う。
 *          Parameter.type (number) への変換は丸めが発生するため、
 *          連続デコードのアキュムレータには bigint の paramType を使うこと。
 */
function decodeKeyValuePair(
  data: Uint8Array,
  offset: number,
  previousType: bigint,
): [Parameter, number, bigint] {
  const [deltaType, deltaConsumed] = decodeVarint(data, offset);
  const paramType = previousType + deltaType;

  // draft-ietf-moq-transport-19 Section 1.4.3:
  // "The previous Type value plus the Delta Type MUST NOT be greater than
  //  2^64 - 1. If a Delta Type is received that would be too large, the
  //  Session MUST be closed with a PROTOCOL_VIOLATION."
  if (paramType > MAX_VARINT) {
    throw new ProtocolViolationError(
      `delta type addition exceeds maximum: ${paramType} > ${MAX_VARINT}`,
    );
  }

  let totalConsumed = deltaConsumed;

  let value: Uint8Array;

  if (paramType % 2n === 1n) {
    // 奇数型: Length プレフィックス付き
    const [length, lengthConsumed] = decodeVarint(data, offset + totalConsumed);
    totalConsumed += lengthConsumed;
    if (Number(length) > MAX_KVP_VALUE_LENGTH) {
      throw new ProtocolViolationError(
        `parameter value length exceeds maximum: ${length} > ${MAX_KVP_VALUE_LENGTH}`,
      );
    }
    value = data.slice(offset + totalConsumed, offset + totalConsumed + Number(length));
    totalConsumed += Number(length);
  } else {
    // 偶数型: varint 値
    const [val, valConsumed] = decodeVarint(data, offset + totalConsumed);
    value = encodeVarint(val);
    totalConsumed += valConsumed;
  }

  return [{ type: Number(paramType), value }, totalConsumed, paramType];
}

/**
 * Key-Value-Pairs をカウントプレフィックスなしでエンコードする
 *
 * draft-ietf-moq-transport-19 Section 10.3 (SETUP):
 * Setup Options は Key-Value-Pairs (Figure 2) としてシリアライズされ、
 * カウントプレフィックスを持たない。Length フィールドで終端が決まる。
 *
 * パラメータは Type の昇順でなければならない。
 */
export function encodeKeyValuePairs(params: Parameter[]): Uint8Array {
  const paramBytes: Uint8Array[] = [];
  let previousType = 0;

  for (const param of params) {
    paramBytes.push(encodeKeyValuePair(param, previousType));
    previousType = param.type;
  }

  const totalLength = paramBytes.reduce((sum, p) => sum + p.length, 0);
  const result = new Uint8Array(totalLength);

  let offset = 0;
  for (const pb of paramBytes) {
    result.set(pb, offset);
    offset += pb.length;
  }

  return result;
}

/**
 * Key-Value-Pairs をカウントプレフィックスなしでデコードする
 *
 * draft-ietf-moq-transport-19 Section 10.3 (SETUP):
 * Setup Options は Key-Value-Pairs (Figure 2) としてシリアライズされ、
 * カウントプレフィックスを持たない。データ末尾まで KVP を読む。
 *
 * @returns [parameters, consumed bytes]
 */
export function decodeKeyValuePairs(data: Uint8Array, offset = 0): [Parameter[], number] {
  const parameters: Parameter[] = [];
  let totalConsumed = 0;
  let previousType = 0n;

  while (offset + totalConsumed < data.length) {
    const [param, paramConsumed, paramType] = decodeKeyValuePair(
      data,
      offset + totalConsumed,
      previousType,
    );
    parameters.push(param);
    totalConsumed += paramConsumed;
    previousType = paramType;
  }

  return [parameters, totalConsumed];
}

/**
 * Message Parameter の Value エンコーディング種別
 *
 * draft-ietf-moq-transport-19 Section 10.2:
 * Value のエンコーディングはパラメータ定義ごとに異なる。
 * - uint8: 1 バイトの符号なし整数
 * - varint: 可変長整数
 * - location: 2 つの連続した varint (Group, Object)
 * - length-prefixed: varint 長 + バイト列 (外側に Length を付加する)
 * - range-filter: 内側 Length 込みのバイト列 (外側 Length は付加しない。
 *   draft-ietf-moq-transport-19 §5.1.3 の 1 Length 構造)
 */
type MessageParameterValueEncoding =
  | "uint8"
  | "varint"
  | "location"
  | "length-prefixed"
  | "range-filter";

/**
 * パラメータ型ごとの Value エンコーディング定義
 *
 * draft-ietf-moq-transport-19 Section 10.2:
 * Message Parameters は Key-Value-Pair (Figure 2) とは異なり、
 * 各パラメータ型が独自の Value エンコーディングを定義する。
 */
const MESSAGE_PARAMETER_VALUE_ENCODING: Record<number, MessageParameterValueEncoding> = {
  // OBJECT_DELIVERY_TIMEOUT (Section 10.2.4)
  0x02: "varint",
  // AUTHORIZATION_TOKEN (Section 10.2.2)
  0x03: "length-prefixed",
  // RENDEZVOUS_TIMEOUT (Section 10.2.6)
  0x04: "varint",
  // SUBGROUP_DELIVERY_TIMEOUT (Section 10.2.3)
  0x06: "varint",
  // EXPIRES (Section 10.2.15)
  0x08: "varint",
  // LARGEST_OBJECT (Section 10.2.16)
  0x09: "location",
  // FILL_TIMEOUT (Section 10.2.5)
  0x0a: "varint",
  // FORWARD (Section 10.2.17)
  0x10: "uint8",
  // SUBSCRIBER_PRIORITY (Section 10.2.7)
  0x20: "uint8",
  // LOCATION_FILTER (Section 10.2.9)
  0x21: "length-prefixed",
  // GROUP_ORDER (Section 10.2.8)
  0x22: "uint8",
  // NEW_GROUP_REQUEST (Section 10.2.18)
  0x32: "varint",
  // TRACK_NAMESPACE_PREFIX (Section 10.2.19)
  0x34: "length-prefixed",
  // Range Filters (draft-ietf-moq-transport-19 Section 5.1.3 / 10.2.10–10.2.14)
  // Value は Length (vi64) + [SetID + [Property Type] + Range 列] の 1 Length 構造。
  // 外側に Length を付加しない (length-prefixed から分離した専用種別)。
  0x25: "range-filter", // SUBGROUP_FILTER
  0x26: "range-filter", // OBJECTID_FILTER
  0x27: "range-filter", // PRIORITY_FILTER
  0x28: "range-filter", // OBJECT_PROPERTY_FILTER
  0x29: "range-filter", // TRACK_PROPERTY_FILTER
};

/**
 * パラメータ型から Value エンコーディングを取得する
 *
 * draft-ietf-moq-transport-19 Section 10.2:
 * "An endpoint that receives an unknown Message Parameter MUST close
 *  the session with PROTOCOL_VIOLATION."
 * https://www.ietf.org/archive/id/draft-ietf-moq-transport-19.html#section-10.2
 *
 * 未知のパラメータ型の場合はエラーをスローする。
 */
function getMessageParameterValueEncoding(paramType: number): MessageParameterValueEncoding {
  const encoding = MESSAGE_PARAMETER_VALUE_ENCODING[paramType];
  if (encoding === undefined) {
    throw new ProtocolViolationError(`unknown message parameter type: 0x${paramType.toString(16)}`);
  }
  return encoding;
}

/**
 * 単一の Message Parameter をエンコードする (delta encoding)
 *
 * draft-ietf-moq-transport-19 Section 10.2:
 * Message Parameter {
 *   Type Delta (vi64),
 *   Value (..)
 * }
 */
function encodeMessageParameter(param: Parameter, previousType: number): Uint8Array {
  const deltaType = param.type - previousType;
  if (deltaType < 0) {
    throw new Error(
      `parameters must be in ascending order: current type=${param.type}, previous type=${previousType}`,
    );
  }

  const deltaBytes = encodeVarint(deltaType);
  const encoding = getMessageParameterValueEncoding(param.type);

  if (encoding === "length-prefixed") {
    const lengthBytes = encodeVarint(param.value.length);
    const result = new Uint8Array(deltaBytes.length + lengthBytes.length + param.value.length);
    result.set(deltaBytes, 0);
    result.set(lengthBytes, deltaBytes.length);
    result.set(param.value, deltaBytes.length + lengthBytes.length);
    return result;
  }

  // uint8, varint, location, range-filter: Value をそのまま書き込む。
  // range-filter の Value は encodeRangeFilter の出力 (内側 Length 込み) のため、
  // 外側 Length は付加しない (1 Length 構造。draft-ietf-moq-transport-19 §5.1.3)
  const result = new Uint8Array(deltaBytes.length + param.value.length);
  result.set(deltaBytes, 0);
  result.set(param.value, deltaBytes.length);
  return result;
}

/**
 * 単一の Message Parameter をデコードする (delta encoding)
 *
 * draft-ietf-moq-transport-19 Section 10.2:
 * Message Parameter {
 *   Type Delta (vi64),
 *   Value (..)
 * }
 *
 * 主に decodeParameters の内部実装として使用される。テスト用に公開するが、
 * 公開 API (src/message/index.ts) には含めない。
 *
 * @returns [parameter, consumed bytes, paramType (bigint)]
 *          paramType は次のパラメータの previousType に使う。
 *          Parameter.type (number) への変換は丸めが発生するため、
 *          連続デコードのアキュムレータには bigint の paramType を使うこと。
 */
export function decodeMessageParameter(
  data: Uint8Array,
  offset: number,
  previousType: bigint,
): [Parameter, number, bigint] {
  const [deltaType, deltaConsumed] = decodeVarint(data, offset);
  const paramType = previousType + deltaType;

  // draft-ietf-moq-transport-19 Section 10.2 (Message Parameters):
  // "If the resulting Type would be greater than 2^64 - 1, the endpoint MUST
  //  close the session with a PROTOCOL_VIOLATION."
  if (paramType > MAX_VARINT) {
    throw new ProtocolViolationError(
      `delta type addition exceeds maximum: ${paramType} > ${MAX_VARINT}`,
    );
  }

  const paramTypeNumber = Number(paramType);
  let totalConsumed = deltaConsumed;

  const encoding = getMessageParameterValueEncoding(paramTypeNumber);
  let value: Uint8Array;

  switch (encoding) {
    case "uint8": {
      value = data.slice(offset + totalConsumed, offset + totalConsumed + 1);
      totalConsumed += 1;
      // draft-ietf-moq-transport-19 §10.2.8 / §10.2.17:
      // FORWARD (0x10) / GROUP_ORDER (0x22) は受信時に値域 MUST 検証
      if (paramTypeNumber === 0x10) {
        validateForwardValue(value[0]);
      } else if (paramTypeNumber === 0x22) {
        validateGroupOrderValue(value[0]);
      }
      break;
    }
    case "varint": {
      const [val, valConsumed] = decodeVarint(data, offset + totalConsumed);
      value = encodeVarint(val);
      totalConsumed += valConsumed;
      break;
    }
    case "location": {
      // Location: 2 つの連続した varint (Group, Object)
      const [group, groupConsumed] = decodeVarint(data, offset + totalConsumed);
      totalConsumed += groupConsumed;
      const [obj, objConsumed] = decodeVarint(data, offset + totalConsumed);
      totalConsumed += objConsumed;
      const groupBytes = encodeVarint(group);
      const objBytes = encodeVarint(obj);
      value = new Uint8Array(groupBytes.length + objBytes.length);
      value.set(groupBytes, 0);
      value.set(objBytes, groupBytes.length);
      break;
    }
    case "length-prefixed": {
      const [length, lengthConsumed] = decodeVarint(data, offset + totalConsumed);
      totalConsumed += lengthConsumed;
      if (Number(length) > MAX_KVP_VALUE_LENGTH) {
        throw new ProtocolViolationError(
          `message parameter value length exceeds maximum: ${length} > ${MAX_KVP_VALUE_LENGTH}`,
        );
      }
      value = data.slice(offset + totalConsumed, offset + totalConsumed + Number(length));
      totalConsumed += Number(length);
      break;
    }
    case "range-filter": {
      // draft-ietf-moq-transport-19 Section 5.1.3:
      // Range Filter の Value は Length (vi64) で始まり、その後に
      // [SetID + [Property Type] + Range 列] が続く 1 Length 構造。
      // 内側 Length を読んで全体を value として保持する (decodeRangeFilter の
      // 入力形式に合わせる。Length を剥がすと SetID を Length と誤読する)。
      const [length, lengthConsumed] = decodeVarint(data, offset + totalConsumed);
      totalConsumed += lengthConsumed;
      // 既存 length-prefixed 分岐と同じ上限を維持する (防御的制限。
      // Range Filter の Length は仕様で上限が明記されていないが、
      // 6 万バイト超のフィルタは実用上存在せず、過大宣言の DoS を防ぐ)
      if (Number(length) > MAX_KVP_VALUE_LENGTH) {
        throw new ProtocolViolationError(
          `message parameter value length exceeds maximum: ${length} > ${MAX_KVP_VALUE_LENGTH}`,
        );
      }
      // 内側 Length が残りバイト数を超える場合はフレーミング破損として
      // PROTOCOL_VIOLATION で扱う (長い slice を作らない)
      if (offset + totalConsumed + Number(length) > data.length) {
        throw new ProtocolViolationError(
          `range filter value length exceeds remaining data: ${length} > ${data.length - (offset + totalConsumed)}`,
        );
      }
      value = data.slice(
        offset + totalConsumed - lengthConsumed,
        offset + totalConsumed + Number(length),
      );
      totalConsumed += Number(length);
      break;
    }
  }

  return [{ type: paramTypeNumber, value }, totalConsumed, paramType];
}

/**
 * Message Parameter リストをエンコードする
 *
 * draft-ietf-moq-transport-19 Section 10.2:
 * Message Parameters はカウントプレフィックス付きでエンコードする。
 * delta encoding を使用して Type を効率的にエンコードする。
 * パラメータは Type の昇順でソートされる。
 */
export function encodeParameters(params: Parameter[]): Uint8Array {
  // Type 昇順でソート
  const sorted = [...params].sort((a, b) => a.type - b.type);

  const countBytes = encodeVarint(sorted.length);
  const paramBytes: Uint8Array[] = [];
  let previousType = 0;

  for (const param of sorted) {
    paramBytes.push(encodeMessageParameter(param, previousType));
    previousType = param.type;
  }

  const totalLength = countBytes.length + paramBytes.reduce((sum, p) => sum + p.length, 0);
  const result = new Uint8Array(totalLength);
  result.set(countBytes, 0);

  let offset = countBytes.length;
  for (const pb of paramBytes) {
    result.set(pb, offset);
    offset += pb.length;
  }

  return result;
}

/**
 * Message Parameter リストをデコードする
 *
 * draft-ietf-moq-transport-19 Section 10.2:
 * Message Parameters はカウントプレフィックス付きでデコードする。
 * delta encoding を使用して Type をデコードする。
 * Value のエンコーディングはパラメータ型ごとに異なる。
 *
 * @returns [parameters, consumed bytes]
 */
export function decodeParameters(data: Uint8Array, offset = 0): [Parameter[], number] {
  const [numParams, consumed] = decodeVarint(data, offset);
  let totalConsumed = consumed;
  const parameters: Parameter[] = [];
  let previousType = 0n;
  const seenTypes = new Set<number>();

  for (let i = 0; i < Number(numParams); i++) {
    const [param, paramConsumed, paramType] = decodeMessageParameter(
      data,
      offset + totalConsumed,
      previousType,
    );

    // draft-ietf-moq-transport-19 Section 10.2:
    // "Receivers SHOULD check that there are no unexpected duplicate parameters
    //  and close the session with PROTOCOL_VIOLATION if found."
    // AUTHORIZATION_TOKEN と Range Filter (0x25–0x29) は複数回出現が許可されているため
    // 重複チェックから除外する
    // draft-ietf-moq-transport-19 Section 5.1.3: Range Filters は複数回 MAY
    const isRepeatable =
      param.type === MessageParameterType.AUTHORIZATION_TOKEN ||
      (param.type >= 0x25 && param.type <= 0x29);
    if (seenTypes.has(param.type) && !isRepeatable) {
      throw new ProtocolViolationError(
        `duplicate message parameter type: 0x${param.type.toString(16)}`,
      );
    }
    seenTypes.add(param.type);

    parameters.push(param);
    totalConsumed += paramConsumed;
    previousType = paramType;
  }

  return [parameters, totalConsumed];
}

/**
 * Location Filter (Section 5.1.2, Section 10.2.9)
 *
 * draft-ietf-moq-transport-19:
 * Location Filter {
 *   Filter Type (vi64),
 *   [Start Location (Location),]
 *   [End Group Delta (vi64),]
 * }
 *
 * End Group Delta は Start Location の Group ID からの差分。
 * 0 の場合は Start Location の Group の残りが対象。
 * draft-ietf-moq-transport-19 Section 10.2
 */
export type LocationFilter =
  | { type: "NextGroupStart" }
  | { type: "LargestObject" }
  | { type: "AbsoluteStart"; startLocation: Location }
  | { type: "AbsoluteRange"; startLocation: Location; endGroupDelta: bigint };

/**
 * Filter Type 定数
 */
const FILTER_TYPE = {
  NEXT_GROUP_START: 0x01,
  LARGEST_OBJECT: 0x02,
  ABSOLUTE_START: 0x03,
  ABSOLUTE_RANGE: 0x04,
} as const;

/**
 * Location Filter をエンコードする
 * draft-ietf-moq-transport-19 Section 10.2.9 (SUBSCRIPTION FILTER Parameter)
 */
export function encodeLocationFilter(filter: LocationFilter): Uint8Array {
  const parts: Uint8Array[] = [];

  switch (filter.type) {
    case "NextGroupStart":
      parts.push(encodeVarint(FILTER_TYPE.NEXT_GROUP_START));
      break;
    case "LargestObject":
      parts.push(encodeVarint(FILTER_TYPE.LARGEST_OBJECT));
      break;
    case "AbsoluteStart":
      parts.push(encodeVarint(FILTER_TYPE.ABSOLUTE_START));
      parts.push(encodeLocation(filter.startLocation));
      break;
    case "AbsoluteRange":
      parts.push(encodeVarint(FILTER_TYPE.ABSOLUTE_RANGE));
      parts.push(encodeLocation(filter.startLocation));
      parts.push(encodeVarint(filter.endGroupDelta));
      break;
  }

  const totalLength = parts.reduce((sum, p) => sum + p.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

/**
 * Location Filter をデコードする
 * @returns [filter, consumed bytes]
 */
export function decodeLocationFilter(data: Uint8Array, offset = 0): [LocationFilter, number] {
  const [filterType, typeConsumed] = decodeVarint(data, offset);
  let totalConsumed = typeConsumed;

  switch (Number(filterType)) {
    case FILTER_TYPE.NEXT_GROUP_START:
      return [{ type: "NextGroupStart" }, totalConsumed];

    case FILTER_TYPE.LARGEST_OBJECT:
      return [{ type: "LargestObject" }, totalConsumed];

    case FILTER_TYPE.ABSOLUTE_START: {
      const [startLocation, locationConsumed] = decodeLocation(data, offset + totalConsumed);
      totalConsumed += locationConsumed;
      return [{ type: "AbsoluteStart", startLocation }, totalConsumed];
    }

    case FILTER_TYPE.ABSOLUTE_RANGE: {
      const [startLocation, locationConsumed] = decodeLocation(data, offset + totalConsumed);
      totalConsumed += locationConsumed;
      const [endGroupDelta, endGroupDeltaConsumed] = decodeVarint(data, offset + totalConsumed);
      totalConsumed += endGroupDeltaConsumed;
      return [{ type: "AbsoluteRange", startLocation, endGroupDelta }, totalConsumed];
    }

    default:
      // draft-ietf-moq-transport-19 §5.1.2:
      // 未知の Filter Type は PROTOCOL_VIOLATION でセッションを閉じる
      throw new ProtocolViolationError(`Unknown filter type: ${filterType}`);
  }
}

/**
 * Location Filter を LOCATION_FILTER パラメータとしてエンコードする
 * Parameter Type: 0x21 (奇数なので Length プレフィックス付き)
 */
export function encodeLocationFilterParameter(filter: LocationFilter): Parameter {
  const value = encodeLocationFilter(filter);
  return {
    type: 0x21,
    value,
  };
}

/**
 * LOCATION_FILTER パラメータをデコードする
 */
export function decodeLocationFilterParameter(param: Parameter): LocationFilter {
  if (param.type !== 0x21) {
    throw new Error(`Invalid parameter type: expected 0x21, got ${param.type}`);
  }
  const [filter] = decodeLocationFilter(param.value, 0);
  return filter;
}

/**
 * TRACK_NAMESPACE_PREFIX パラメータをエンコードする
 *
 * draft-ietf-moq-transport-19 §10.2.19:
 * "The TRACK_NAMESPACE_PREFIX parameter (Parameter Type 0x34) uses the
 *  Track Namespace encoding described in Section 2.4.1."
 */
export function encodeParameterTrackNamespace(namespace: TrackNamespace): Parameter {
  const value = encodeTrackNamespace(namespace);
  return { type: 0x34, value };
}

/**
 * TRACK_NAMESPACE_PREFIX パラメータから Track Namespace を取得する
 *
 * draft-ietf-moq-transport-19 §10.2.19:
 * "The TRACK_NAMESPACE_PREFIX parameter (Parameter Type 0x34) uses the
 *  Track Namespace encoding described in Section 2.4.1."
 */
export function getParameterTrackNamespace(param: Parameter): TrackNamespace {
  if (param.type !== 0x34) {
    throw new Error(`Invalid parameter type: expected 0x34, got ${param.type}`);
  }
  const [namespace] = decodeTrackNamespace(param.value);
  return namespace;
}

// ============================================================================
// Range Filters (draft-ietf-moq-transport-19 Section 5.1.3)
// ============================================================================

/**
 * Range Filter の単一 Range
 *
 * draft-ietf-moq-transport-19 Section 5.1.3:
 * Start は直前 Range の End からの delta（先頭は 0 から）。
 * End は当該 Start からの delta。末尾 Range のみ End 省略可（open-ended）。
 */
export interface FilterRange {
  start: bigint;
  end?: bigint;
}

/**
 * Range Filter パラメータ
 *
 * draft-ietf-moq-transport-19 Section 5.1.3:
 * 同一 SetID 内は AND、異なる SetID 間は OR。
 */
export interface RangeFilterParam {
  type: "subgroup" | "objectId" | "priority" | "objectProperty" | "trackProperty";
  setId: number;
  /** OBJECT_PROPERTY_FILTER / TRACK_PROPERTY_FILTER のみ使用。偶数であること */
  propertyType?: bigint;
  ranges: FilterRange[];
}

/**
 * Range Filter の削除（REQUEST_UPDATE で Length=0）
 */
export interface RangeFilterRemove {
  type: "subgroup" | "objectId" | "priority" | "objectProperty" | "trackProperty";
  remove: true;
}

/** Range Filter の送信指定（追加または削除） */
export type RangeFilterSpec = RangeFilterParam | RangeFilterRemove;

/**
 * Range Filter のワイヤエンコーディング
 *
 * draft-ietf-moq-transport-19 Section 5.1.3:
 * Value = Length (vi64) + [SetID (8 bit) + [Property Type (vi64)] + Range 列]
 * Length = 0 は削除を意味する。
 */
export function encodeRangeFilter(spec: RangeFilterSpec): Uint8Array {
  if ("remove" in spec && spec.remove) {
    // Length = 0（削除）
    return encodeVarint(0n);
  }

  const param = spec as RangeFilterParam;
  const parts: Uint8Array[] = [];

  // draft-ietf-moq-transport-19 Section 5.1.3:
  // Range Filter は 1 つ以上の Range を持つ。空の ranges はデコード側
  // (decodeRangeFilter の「no ranges」検証) が InvalidFilterError で拒否する
  // ため、送信前に検出する。
  if (param.ranges.length === 0) {
    throw new InvalidFilterError("range filter must have at least one range");
  }

  // draft-ietf-moq-transport-19 Section 5.1.3:
  // SetID は 8 bit (0-255) のため、範囲外の値は送信できない
  if (!Number.isInteger(param.setId) || param.setId < 0 || param.setId > 255) {
    throw new InvalidFilterError(`set id out of range: ${param.setId}, expected 0-255`);
  }

  // SetID (8 bit)
  parts.push(new Uint8Array([param.setId]));

  // Property Type (vi64) - OBJECT_PROPERTY_FILTER / TRACK_PROPERTY_FILTER のみ
  if (param.type === "objectProperty" || param.type === "trackProperty") {
    if (param.propertyType === undefined) {
      throw new Error("propertyType is required for objectProperty/trackProperty filter");
    }
    // draft-ietf-moq-transport-19 §10.2.13 / §10.2.14:
    // Property Type は偶数でなければならない
    if (param.propertyType % 2n !== 0n) {
      throw new InvalidFilterError(`property type must be even: ${param.propertyType}`);
    }
    parts.push(encodeVarint(param.propertyType));
  }

  // Range 列（delta エンコーディング）
  let prevEnd = 0n;
  for (let i = 0; i < param.ranges.length; i++) {
    const range = param.ranges[i];
    const startDelta = range.start - prevEnd;
    if (startDelta < 0n) {
      throw new Error("range start must be >= previous end");
    }
    // draft-ietf-moq-transport-19 §5.1.3:
    // "Any delta encoding that results in a value that exceeds 2^64-1
    //  MUST be rejected with REQUEST_ERROR with error code INVALID_FILTER."
    if (range.start > MAX_VARINT) {
      throw new InvalidFilterError(`range start exceeds maximum: ${range.start} > ${MAX_VARINT}`);
    }
    parts.push(encodeVarint(startDelta));

    if (range.end !== undefined) {
      const endDelta = range.end - range.start;
      if (endDelta < 0n) {
        throw new Error("range end must be >= range start");
      }
      if (range.end > MAX_VARINT) {
        throw new InvalidFilterError(`range end exceeds maximum: ${range.end} > ${MAX_VARINT}`);
      }
      parts.push(encodeVarint(endDelta));
      prevEnd = range.end;
    } else {
      // 末尾 Range のみ End 省略可
      if (i !== param.ranges.length - 1) {
        throw new Error("only the last range may omit end");
      }
    }
  }

  // draft-ietf-moq-transport-19 §10.2.12:
  // Publisher Priority は 8 bit のため、PRIORITY_FILTER の値は 255 以下でなければならない
  if (param.type === "priority") {
    for (const range of param.ranges) {
      if (range.start > 255n) {
        throw new InvalidFilterError(`priority filter value exceeds maximum: ${range.start} > 255`);
      }
      if (range.end !== undefined && range.end > 255n) {
        throw new InvalidFilterError(`priority filter value exceeds maximum: ${range.end} > 255`);
      }
    }
  }

  const body = concatUint8Arrays(parts);
  const result = new Uint8Array(encodeVarint(BigInt(body.length)).length + body.length);
  const lenBytes = encodeVarint(BigInt(body.length));
  result.set(lenBytes, 0);
  result.set(body, lenBytes.length);
  return result;
}

/**
 * Range Filter のワイヤデコード
 *
 * draft-ietf-moq-transport-19 Section 5.1.3:
 * 値域・構造の不正は InvalidFilterError で検出する (REQUEST_ERROR
 * (INVALID_FILTER) 応答または PROTOCOL_VIOLATION セッション閉鎖は
 * 受信経路の責務)。
 *
 * @returns [RangeFilterSpec, consumed bytes]
 */
export function decodeRangeFilter(
  type: "subgroup" | "objectId" | "priority" | "objectProperty" | "trackProperty",
  data: Uint8Array,
  offset = 0,
): [RangeFilterSpec, number] {
  const [length, lengthSize] = decodeVarint(data, offset);
  let totalConsumed = lengthSize;

  // Length = 0 は削除
  if (Number(length) === 0) {
    return [{ type, remove: true }, totalConsumed];
  }

  const bodyStart = offset + totalConsumed;
  const bodyEnd = bodyStart + Number(length);

  // 構造不正: Length > 0 なのに SetID が欠落
  if (bodyStart >= data.length) {
    throw new InvalidFilterError("range filter is missing SetID");
  }

  // SetID (8 bit)
  const setId = data[bodyStart];
  let pos = bodyStart + 1;

  // Property Type (vi64) - OBJECT_PROPERTY_FILTER / TRACK_PROPERTY_FILTER のみ
  let propertyType: bigint | undefined;
  if (type === "objectProperty" || type === "trackProperty") {
    // 構造不正: SetID のみで Property Type が欠落
    if (pos >= bodyEnd) {
      throw new InvalidFilterError("range filter is missing property type");
    }
    const [pt, ptSize] = decodeRangeFilterVarint(data, pos);
    // draft-ietf-moq-transport-19 §10.2.13 / §10.2.14:
    // Property Type は偶数でなければならない
    if (pt % 2n !== 0n) {
      throw new InvalidFilterError(`property type must be even: ${pt}`);
    }
    propertyType = pt;
    pos += ptSize;
  }

  // Range 列（delta デコーディング）
  const ranges: FilterRange[] = [];
  let prevEnd = 0n;
  while (pos < bodyEnd) {
    const [startDelta, startDeltaSize] = decodeRangeFilterVarint(data, pos);
    pos += startDeltaSize;
    const start = prevEnd + startDelta;

    // draft-ietf-moq-transport-19 §5.1.3:
    // "Any delta encoding that results in a value that exceeds 2^64-1
    //  MUST be rejected with REQUEST_ERROR with error code INVALID_FILTER."
    if (start > MAX_VARINT) {
      throw new InvalidFilterError(`range start exceeds maximum: ${start} > ${MAX_VARINT}`);
    }

    if (pos >= bodyEnd) {
      // 末尾 Range の End 省略（open-ended）
      ranges.push({ start });
      break;
    }

    const [endDelta, endDeltaSize] = decodeRangeFilterVarint(data, pos);
    pos += endDeltaSize;
    const end = start + endDelta;
    if (end > MAX_VARINT) {
      throw new InvalidFilterError(`range end exceeds maximum: ${end} > ${MAX_VARINT}`);
    }
    ranges.push({ start, end });
    prevEnd = end;
  }

  // 構造不正: Length > 0 なのに Range 列が欠落
  if (ranges.length === 0) {
    throw new InvalidFilterError("range filter has no ranges");
  }

  // draft-ietf-moq-transport-19 §10.2.12:
  // Publisher Priority は 8 bit のため、PRIORITY_FILTER の値は 255 以下でなければならない
  if (type === "priority") {
    for (const range of ranges) {
      if (range.start > 255n) {
        throw new InvalidFilterError(`priority filter value exceeds maximum: ${range.start} > 255`);
      }
      if (range.end !== undefined && range.end > 255n) {
        throw new InvalidFilterError(`priority filter value exceeds maximum: ${range.end} > 255`);
      }
    }
  }

  totalConsumed += Number(length);
  return [{ type, setId, propertyType, ranges }, totalConsumed];
}

/**
 * Range Filter 内部の varint デコード
 *
 * draft-ietf-moq-transport-19 §5.1.3:
 * 宣言 Length 内で varint が途中終端するケース (構造不正) は
 * IncompleteDataError のままにせず InvalidFilterError に変換して扱う。
 * IncompleteDataError は受信ループの toProtocolViolationSessionError で
 * 変換されず黙殺されるため、構造不正を検出できないとセッションが
 * 開いたまま応答なしになる。
 */
function decodeRangeFilterVarint(data: Uint8Array, offset: number): [bigint, number] {
  try {
    return decodeVarint(data, offset);
  } catch (error) {
    if (error instanceof IncompleteDataError) {
      throw new InvalidFilterError("truncated varint in range filter");
    }
    throw error;
  }
}

/**
 * Range Filter パラメータの組み合わせ重複を検証する
 *
 * draft-ietf-moq-transport-19 §5.1.3:
 * "If the same combination of Parameter Type, SetID, and Property Type
 *  (only in the Track and Object Property Filters) repeat in any message,
 *  an endpoint MUST reject this with REQUEST_ERROR with error code
 *  INVALID_FILTER."
 *
 * Length=0 の削除エントリは SetID / Property Type を持たないため重複判定の対象外。
 * 違反時は InvalidFilterError を throw する。
 *
 * @param parameters - デコード済みのパラメータ配列
 */
export function validateRangeFilterCombination(parameters: Parameter[]): void {
  const seenCombinations = new Set<string>();
  for (const param of parameters) {
    if (param.type < 0x25 || param.type > 0x29) {
      continue;
    }
    const filterType = rangeFilterTypeOf(param.type);
    const [decoded] = decodeRangeFilter(filterType, param.value);
    if ("remove" in decoded) {
      continue;
    }
    // (Parameter Type, SetID, [Property Type]) の組み合わせキー
    const combinationKey = `${param.type}:${decoded.setId}:${decoded.propertyType ?? ""}`;
    if (seenCombinations.has(combinationKey)) {
      throw new InvalidFilterError(`duplicate range filter combination: ${combinationKey}`);
    }
    seenCombinations.add(combinationKey);
  }
}

/**
 * パラメータタイプ (0x25-0x29) から Range Filter の種別名を返す
 */
function rangeFilterTypeOf(
  type: number,
): "subgroup" | "objectId" | "priority" | "objectProperty" | "trackProperty" {
  switch (type) {
    case 0x25:
      return "subgroup";
    case 0x26:
      return "objectId";
    case 0x27:
      return "priority";
    case 0x28:
      return "objectProperty";
    case 0x29:
      return "trackProperty";
    default:
      throw new InvalidFilterError(`unknown range filter parameter type: 0x${type.toString(16)}`);
  }
}

/** Uint8Array 配列を連結するヘルパー */
function concatUint8Arrays(arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((sum, a) => sum + a.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}
