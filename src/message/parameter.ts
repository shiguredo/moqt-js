/**
 * MOQT Parameter encoding/decoding
 * draft-ietf-moq-transport-17 Section 9.3 (Message Parameter)
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
 * https://github.com/moq-wg/moq-transport/pull/1462
 */

import { ProtocolViolationError } from "../error";
import { decodeVarint, encodeVarint } from "../varint";
import type { Location } from "./types";

/**
 * Track Namespace / Full Track Name の最大サイズ（バイト）
 *
 * draft-ietf-moq-transport-17:
 * Track Namespace と Full Track Name は最大 4,096 バイト。
 * 超過時は PROTOCOL_VIOLATION でセッションを終了する。
 * https://github.com/moq-wg/moq-transport/pull/1399
 */
export const MAX_TRACK_NAMESPACE_SIZE = 4096;
export const MAX_TRACK_NAME_SIZE = 4096;
/**
 * Track Namespace の最大フィールド数
 *
 * draft-ietf-moq-transport-17 Section 9.20 (SUBSCRIBE_NAMESPACE):
 * "receives a Track Namespace Prefix consisting of greater than
 *  32 Track Namespace Fields, it MUST close the session with a
 *  PROTOCOL_VIOLATION."
 */
export const MAX_TRACK_NAMESPACE_FIELDS = 32;
/**
 * Reason Phrase の最大長 (バイト)
 *
 * draft-ietf-moq-transport-17 Section 1.4.4:
 * "The reason phrase length has a maximum value of 1024 bytes.
 *  If an endpoint receives a length exceeding the maximum,
 *  it MUST close the session with a PROTOCOL_VIOLATION"
 */
export const MAX_REASON_PHRASE_LENGTH = 1024;

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
 * draft-ietf-moq-transport-17 Section 9.3.9 (LARGEST OBJECT Parameter)
 */
export function getParameterLocationValue(param: Parameter): Location {
  const [location] = decodeLocation(param.value, 0);
  return location;
}

/**
 * GROUP_ORDER パラメータの値を検証する
 *
 * draft-ietf-moq-transport-17 Section 9.3.6:
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
 * draft-ietf-moq-transport-17 Section 9.3.10:
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
 * Track Namespace (Section 2.4.1)
 */
export interface TrackNamespace {
  tuple: Uint8Array[];
}

/**
 * Track Namespace をエンコードする
 *
 * draft-ietf-moq-transport-17:
 * Track Namespace は最大 4,096 バイト。
 * https://github.com/moq-wg/moq-transport/pull/1399
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
 * draft-ietf-moq-transport-17:
 * Track Namespace は最大 4,096 バイト。
 * https://github.com/moq-wg/moq-transport/pull/1399
 *
 * @returns [namespace, consumed bytes]
 */
export function decodeTrackNamespace(data: Uint8Array, offset = 0): [TrackNamespace, number] {
  const [numElements, consumed] = decodeVarint(data, offset);
  let totalConsumed = consumed;

  // draft-ietf-moq-transport-17 Section 9.20 (SUBSCRIBE_NAMESPACE):
  // フィールド数が 32 を超える場合は PROTOCOL_VIOLATION
  if (Number(numElements) > MAX_TRACK_NAMESPACE_FIELDS) {
    throw new Error(
      `track namespace fields exceeds maximum: ${numElements} > ${MAX_TRACK_NAMESPACE_FIELDS}`,
    );
  }

  const elements: Uint8Array[] = [];
  let dataSize = 0;

  for (let i = 0; i < Number(numElements); i++) {
    const [elemLen, lenConsumed] = decodeVarint(data, offset + totalConsumed);
    totalConsumed += lenConsumed;
    // draft-ietf-moq-transport-17 Section 2.3:
    // "Each Track Namespace Field Value MUST contain at least one byte.
    //  If an endpoint receives a Track Namespace Field with a Track
    //  Namespace Field Length of 0, it MUST close the session with a
    //  PROTOCOL_VIOLATION."
    if (elemLen === 0n) {
      throw new Error("track namespace field length is zero");
    }
    const element = data.slice(offset + totalConsumed, offset + totalConsumed + Number(elemLen));
    elements.push(element);
    totalConsumed += Number(elemLen);
    dataSize += Number(elemLen);
  }

  if (dataSize > MAX_TRACK_NAMESPACE_SIZE) {
    throw new Error(
      `track namespace exceeds maximum size: ${dataSize} > ${MAX_TRACK_NAMESPACE_SIZE}`,
    );
  }

  return [{ tuple: elements }, totalConsumed];
}

/**
 * string[] から TrackNamespace を作成
 *
 * draft-ietf-moq-transport-17:
 * Track Namespace は最大 4,096 バイト。
 * https://github.com/moq-wg/moq-transport/pull/1399
 */
export function createTrackNamespace(parts: string[]): TrackNamespace {
  const encoder = new TextEncoder();
  const tuple = parts.map((p) => encoder.encode(p));

  // draft-ietf-moq-transport-17 Section 2.3:
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
 * Track Name をエンコードする（サイズ検証付き）
 *
 * draft-ietf-moq-transport-17:
 * Full Track Name は最大 4,096 バイト。
 * https://github.com/moq-wg/moq-transport/pull/1399
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
 * draft-ietf-moq-transport-17:
 * Full Track Name は最大 4,096 バイト。
 * https://github.com/moq-wg/moq-transport/pull/1399
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
 * draft-ietf-moq-transport-17 Section 1.4.3 (Key-Value-Pair Structure):
 * https://www.ietf.org/archive/id/draft-ietf-moq-transport-17.html#section-1.4.3
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
 * 単一のパラメータを delta encoding でデコードする
 *
 * @param data - デコードするデータ
 * @param offset - 開始オフセット
 * @param previousType - 前のパラメータの Type 値（最初のパラメータの場合は 0）
 * @returns [parameter, consumed bytes]
 */
function decodeKeyValuePair(
  data: Uint8Array,
  offset: number,
  previousType: number,
): [Parameter, number] {
  const [deltaType, deltaConsumed] = decodeVarint(data, offset);
  const paramType = previousType + Number(deltaType);
  let totalConsumed = deltaConsumed;

  let value: Uint8Array;

  if (paramType % 2 === 1) {
    // 奇数型: Length プレフィックス付き
    const [length, lengthConsumed] = decodeVarint(data, offset + totalConsumed);
    totalConsumed += lengthConsumed;
    value = data.slice(offset + totalConsumed, offset + totalConsumed + Number(length));
    totalConsumed += Number(length);
  } else {
    // 偶数型: varint 値
    const [val, valConsumed] = decodeVarint(data, offset + totalConsumed);
    value = encodeVarint(val);
    totalConsumed += valConsumed;
  }

  return [{ type: paramType, value }, totalConsumed];
}

/**
 * Key-Value-Pairs をカウントプレフィックスなしでエンコードする
 *
 * draft-ietf-moq-transport-17 Section 9.4 (SETUP):
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
 * draft-ietf-moq-transport-17 Section 9.4 (SETUP):
 * Setup Options は Key-Value-Pairs (Figure 2) としてシリアライズされ、
 * カウントプレフィックスを持たない。データ末尾まで KVP を読む。
 *
 * @returns [parameters, consumed bytes]
 */
export function decodeKeyValuePairs(data: Uint8Array, offset = 0): [Parameter[], number] {
  const parameters: Parameter[] = [];
  let totalConsumed = 0;
  let previousType = 0;

  while (offset + totalConsumed < data.length) {
    const [param, paramConsumed] = decodeKeyValuePair(data, offset + totalConsumed, previousType);
    parameters.push(param);
    totalConsumed += paramConsumed;
    previousType = param.type;
  }

  return [parameters, totalConsumed];
}

/**
 * Message Parameter の Value エンコーディング種別
 *
 * draft-ietf-moq-transport-17 Section 9.3:
 * Value のエンコーディングはパラメータ定義ごとに異なる。
 * - uint8: 1 バイトの符号なし整数
 * - varint: 可変長整数
 * - location: 2 つの連続した varint (Group, Object)
 * - length-prefixed: varint 長 + バイト列
 */
type MessageParameterValueEncoding = "uint8" | "varint" | "location" | "length-prefixed";

/**
 * パラメータ型ごとの Value エンコーディング定義
 *
 * draft-ietf-moq-transport-17 Section 9.3:
 * Message Parameters は Key-Value-Pair (Figure 2) とは異なり、
 * 各パラメータ型が独自の Value エンコーディングを定義する。
 */
const MESSAGE_PARAMETER_VALUE_ENCODING: Record<number, MessageParameterValueEncoding> = {
  // DELIVERY_TIMEOUT (Section 9.3.3)
  0x02: "varint",
  // AUTHORIZATION_TOKEN (Section 9.3.2)
  0x03: "length-prefixed",
  // RENDEZVOUS_TIMEOUT (Section 9.3.4)
  0x04: "varint",
  // EXPIRES (Section 9.3.8)
  0x08: "varint",
  // LARGEST_OBJECT (Section 9.3.9)
  0x09: "location",
  // FORWARD (Section 9.3.10)
  0x10: "uint8",
  // SUBSCRIBER_PRIORITY (Section 9.3.5)
  0x20: "uint8",
  // SUBSCRIPTION_FILTER (Section 9.3.7)
  0x21: "length-prefixed",
  // GROUP_ORDER (Section 9.3.6)
  0x22: "uint8",
  // NEW_GROUP_REQUEST (Section 9.3.11)
  0x32: "varint",
};

/**
 * パラメータ型から Value エンコーディングを取得する
 *
 * draft-ietf-moq-transport-17 Section 9.3:
 * "An endpoint that receives an unknown Message Parameter MUST close
 *  the session with PROTOCOL_VIOLATION."
 * https://www.ietf.org/archive/id/draft-ietf-moq-transport-17.html#section-9.3
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
 * draft-ietf-moq-transport-17 Section 9.3:
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

  // uint8, varint, location: Value をそのまま書き込む
  const result = new Uint8Array(deltaBytes.length + param.value.length);
  result.set(deltaBytes, 0);
  result.set(param.value, deltaBytes.length);
  return result;
}

/**
 * 単一の Message Parameter をデコードする (delta encoding)
 *
 * draft-ietf-moq-transport-17 Section 9.3:
 * Message Parameter {
 *   Type Delta (vi64),
 *   Value (..)
 * }
 */
function decodeMessageParameter(
  data: Uint8Array,
  offset: number,
  previousType: number,
): [Parameter, number] {
  const [deltaType, deltaConsumed] = decodeVarint(data, offset);
  const paramType = previousType + Number(deltaType);
  let totalConsumed = deltaConsumed;

  const encoding = getMessageParameterValueEncoding(paramType);
  let value: Uint8Array;

  switch (encoding) {
    case "uint8": {
      value = data.slice(offset + totalConsumed, offset + totalConsumed + 1);
      totalConsumed += 1;
      // draft-ietf-moq-transport-17 §9.3.6 / §9.3.10:
      // FORWARD (0x10) / GROUP_ORDER (0x22) は受信時に値域 MUST 検証
      if (paramType === 0x10) {
        validateForwardValue(value[0]);
      } else if (paramType === 0x22) {
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
      value = data.slice(offset + totalConsumed, offset + totalConsumed + Number(length));
      totalConsumed += Number(length);
      break;
    }
  }

  return [{ type: paramType, value }, totalConsumed];
}

/**
 * Message Parameter リストをエンコードする
 *
 * draft-ietf-moq-transport-17 Section 9.3:
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
 * draft-ietf-moq-transport-17 Section 9.3:
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
  let previousType = 0;
  const seenTypes = new Set<number>();

  for (let i = 0; i < Number(numParams); i++) {
    const [param, paramConsumed] = decodeMessageParameter(
      data,
      offset + totalConsumed,
      previousType,
    );

    // draft-ietf-moq-transport-17 Section 9.3:
    // "Receivers SHOULD check that there are no unexpected duplicate parameters
    //  and close the session with PROTOCOL_VIOLATION if found."
    // https://www.ietf.org/archive/id/draft-ietf-moq-transport-17.html#section-9.3
    if (seenTypes.has(param.type)) {
      throw new ProtocolViolationError(
        `duplicate message parameter type: 0x${param.type.toString(16)}`,
      );
    }
    seenTypes.add(param.type);

    parameters.push(param);
    totalConsumed += paramConsumed;
    previousType = param.type;
  }

  return [parameters, totalConsumed];
}

/**
 * Subscription Filter (Section 5.1.2, Section 9.3.7)
 *
 * draft-ietf-moq-transport-17:
 * Subscription Filter {
 *   Filter Type (vi64),
 *   [Start Location (Location),]
 *   [End Group Delta (vi64),]
 * }
 *
 * End Group Delta は Start Location の Group ID からの差分。
 * 0 の場合は Start Location の Group の残りが対象。
 * https://github.com/moq-wg/moq-transport/pull/1470
 */
export type SubscriptionFilter =
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
 * Subscription Filter をエンコードする
 * draft-ietf-moq-transport-17 Section 9.3.7
 */
export function encodeSubscriptionFilter(filter: SubscriptionFilter): Uint8Array {
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
 * Subscription Filter をデコードする
 * @returns [filter, consumed bytes]
 */
export function decodeSubscriptionFilter(
  data: Uint8Array,
  offset = 0,
): [SubscriptionFilter, number] {
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
      throw new Error(`Unknown filter type: ${filterType}`);
  }
}

/**
 * Subscription Filter を SUBSCRIPTION_FILTER パラメータとしてエンコードする
 * Parameter Type: 0x21 (奇数なので Length プレフィックス付き)
 */
export function encodeSubscriptionFilterParameter(filter: SubscriptionFilter): Parameter {
  const value = encodeSubscriptionFilter(filter);
  return {
    type: 0x21,
    value,
  };
}

/**
 * SUBSCRIPTION_FILTER パラメータをデコードする
 */
export function decodeSubscriptionFilterParameter(param: Parameter): SubscriptionFilter {
  if (param.type !== 0x21) {
    throw new Error(`Invalid parameter type: expected 0x21, got ${param.type}`);
  }
  const [filter] = decodeSubscriptionFilter(param.value, 0);
  return filter;
}
