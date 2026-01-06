/**
 * MOQT Parameter encoding/decoding
 * draft-ietf-moq-transport-15 Section 9.2
 */

import { decodeVarint, encodeVarint } from "../varint";
import type { Location } from "./types";

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
 * draft-ietf-moq-transport-15 Section 9.2.1.9
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
 */
export function encodeTrackNamespace(namespace: TrackNamespace): Uint8Array {
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
 * @returns [namespace, consumed bytes]
 */
export function decodeTrackNamespace(data: Uint8Array, offset = 0): [TrackNamespace, number] {
  const [numElements, consumed] = decodeVarint(data, offset);
  let totalConsumed = consumed;
  const elements: Uint8Array[] = [];

  for (let i = 0; i < Number(numElements); i++) {
    const [elemLen, lenConsumed] = decodeVarint(data, offset + totalConsumed);
    totalConsumed += lenConsumed;
    const element = data.slice(offset + totalConsumed, offset + totalConsumed + Number(elemLen));
    elements.push(element);
    totalConsumed += Number(elemLen);
  }

  return [{ tuple: elements }, totalConsumed];
}

/**
 * string[] から TrackNamespace を作成
 */
export function createTrackNamespace(parts: string[]): TrackNamespace {
  const encoder = new TextEncoder();
  return {
    tuple: parts.map((p) => encoder.encode(p)),
  };
}

/**
 * TrackNamespace を string[] に変換
 */
export function trackNamespaceToStrings(namespace: TrackNamespace): string[] {
  const decoder = new TextDecoder();
  return namespace.tuple.map((t) => decoder.decode(t));
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
 * パラメータリストをエンコードする
 */
export function encodeParameters(params: Parameter[]): Uint8Array {
  const countBytes = encodeVarint(params.length);
  const paramBytes = params.map(encodeParameter);

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
 * @returns [parameters, consumed bytes]
 */
export function decodeParameters(data: Uint8Array, offset = 0): [Parameter[], number] {
  const [numParams, consumed] = decodeVarint(data, offset);
  let totalConsumed = consumed;
  const parameters: Parameter[] = [];

  for (let i = 0; i < Number(numParams); i++) {
    const [param, paramConsumed] = decodeParameter(data, offset + totalConsumed);
    parameters.push(param);
    totalConsumed += paramConsumed;
  }

  return [parameters, totalConsumed];
}

/**
 * Subscription Filter (Section 5.1.2, Section 9.2.1.7)
 *
 * draft-ietf-moq-transport-15:
 * Subscription Filter {
 *   Filter Type (i),
 *   [Start Location (Location),]
 *   [End Group (i),]
 * }
 */
export type SubscriptionFilter =
  | { type: "NextGroupStart" }
  | { type: "LargestObject" }
  | { type: "AbsoluteStart"; startLocation: Location }
  | { type: "AbsoluteRange"; startLocation: Location; endGroup: bigint };

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
 * draft-ietf-moq-transport-15 Section 9.2.1.7
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
      parts.push(encodeVarint(filter.endGroup));
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
      const [endGroup, endGroupConsumed] = decodeVarint(data, offset + totalConsumed);
      totalConsumed += endGroupConsumed;
      return [{ type: "AbsoluteRange", startLocation, endGroup }, totalConsumed];
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
