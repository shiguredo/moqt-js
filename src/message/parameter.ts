/**
 * MOQT Parameter encoding/decoding
 * draft-ietf-moq-transport-17 Section 9.3
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

import { decodeVarint, encodeVarint } from "../varint";
import type { Location } from "./types";

/**
 * Track Namespace / Full Track Name の最大サイズ（バイト）
 *
 * draft-ietf-moq-transport-16:
 * Track Namespace と Full Track Name は最大 4,096 バイト。
 * 超過時は PROTOCOL_VIOLATION でセッションを終了する。
 * https://github.com/moq-wg/moq-transport/pull/1399
 */
export const MAX_TRACK_NAMESPACE_SIZE = 4096;
export const MAX_TRACK_NAME_SIZE = 4096;

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
 * draft-ietf-moq-transport-16 Section 9.2.2.7
 */
export function getParameterLocationValue(param: Parameter): Location {
  const [location] = decodeLocation(param.value, 0);
  return location;
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
 * draft-ietf-moq-transport-16:
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
 * draft-ietf-moq-transport-16:
 * Track Namespace は最大 4,096 バイト。
 * https://github.com/moq-wg/moq-transport/pull/1399
 *
 * @returns [namespace, consumed bytes]
 */
export function decodeTrackNamespace(data: Uint8Array, offset = 0): [TrackNamespace, number] {
  const [numElements, consumed] = decodeVarint(data, offset);
  let totalConsumed = consumed;
  const elements: Uint8Array[] = [];
  let dataSize = 0;

  for (let i = 0; i < Number(numElements); i++) {
    const [elemLen, lenConsumed] = decodeVarint(data, offset + totalConsumed);
    totalConsumed += lenConsumed;
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
 * draft-ietf-moq-transport-16:
 * Track Namespace は最大 4,096 バイト。
 * https://github.com/moq-wg/moq-transport/pull/1399
 */
export function createTrackNamespace(parts: string[]): TrackNamespace {
  const encoder = new TextEncoder();
  const tuple = parts.map((p) => encoder.encode(p));

  let dataSize = 0;
  for (const element of tuple) {
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
 * draft-ietf-moq-transport-16:
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
 * draft-ietf-moq-transport-16:
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
 * draft-ietf-moq-transport-16 Section 9.2:
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
 * draft-ietf-moq-transport-17 Section 9.4:
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
 * draft-ietf-moq-transport-17 Section 9.4:
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
 * パラメータリストをエンコードする
 *
 * draft-ietf-moq-transport-17 Section 9.3:
 * Message Parameters はカウントプレフィックス付きでエンコードする。
 * delta encoding を使用して Type を効率的にエンコードする。
 * パラメータは Type の昇順でなければならない。
 */
export function encodeParameters(params: Parameter[]): Uint8Array {
  const countBytes = encodeVarint(params.length);
  const paramBytes: Uint8Array[] = [];
  let previousType = 0;

  for (const param of params) {
    paramBytes.push(encodeKeyValuePair(param, previousType));
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
 * パラメータリストをデコードする
 *
 * draft-ietf-moq-transport-17 Section 9.3:
 * Message Parameters はカウントプレフィックス付きでデコードする。
 * delta encoding を使用して Type をデコードする。
 *
 * @returns [parameters, consumed bytes]
 */
export function decodeParameters(data: Uint8Array, offset = 0): [Parameter[], number] {
  const [numParams, consumed] = decodeVarint(data, offset);
  let totalConsumed = consumed;
  const parameters: Parameter[] = [];
  let previousType = 0;

  for (let i = 0; i < Number(numParams); i++) {
    const [param, paramConsumed] = decodeKeyValuePair(data, offset + totalConsumed, previousType);
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
