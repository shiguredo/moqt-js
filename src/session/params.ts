/**
 * MOQT Session の純粋関数群
 *
 * WebTransport や SessionImpl の状態に依存しない、入出力が明確な関数。
 * PBT (Property-Based Testing) の対象。
 */

import { FetchHeaderType } from "../dataStream";
import type { Parameter, Location } from "../message";
import type { PublishOptions, SubscribeOptions } from "../session";
import {
  MessageParameterType,
  encodeLocationFilterParameter,
  encodeRangeFilter,
  encodeUint8ParameterValue,
  validateForwardValue,
  getParameterLocationValue,
} from "../message";
import { encodeAuthorizationToken } from "../message/authorizationToken";
import { encodeVarint } from "../varint";
import { TrackPropertyId, type Property } from "../properties";

// ============================================================================
// 値域検証ヘルパー
// ============================================================================

/**
 * 値が 0 以上であることを検証する
 * draft-ietf-moq-transport-19 §10.2.4, §10.2.6, §10.2.15, §10.2.18, §12.1, §12.2
 */
function validateNonNegative(value: bigint, name: string): void {
  if (value < 0n) {
    throw new Error(`${name} must not be negative: ${value}`);
  }
}

/**
 * DEFAULT PUBLISHER PRIORITY の値域 (0-255) を検証する
 * draft-ietf-moq-transport-19 §12.4:
 * 「The value is from 0 to 255 and lower numbers get higher priority.
 *  Priorities above 255 are invalid.」
 */
const DEFAULT_PUBLISHER_PRIORITY_MIN = 0;
const DEFAULT_PUBLISHER_PRIORITY_MAX = 255;

// ============================================================================
// PUBLISH 用
// ============================================================================

/**
 * 純粋関数: PUBLISH の Message Parameters を構築する
 *
 * draft-ietf-moq-transport-19 Section 10.2
 */
export function buildPublishParameters(options?: PublishOptions): Parameter[] {
  const parameters: Parameter[] = [];

  // EXPIRES (0x08) - draft-ietf-moq-transport-19 Section 10.2.15 (EXPIRES Parameter)
  if (options?.expires !== undefined) {
    validateNonNegative(options.expires, "EXPIRES");
    parameters.push({
      type: MessageParameterType.EXPIRES,
      value: encodeVarint(options.expires),
    });
  }

  // FORWARD (0x10) - draft-ietf-moq-transport-19 Section 10.2.17 (FORWARD Parameter)
  // デフォルトは 1 なので、明示的に false (0) が指定された場合のみ送信
  if (options?.forward === false) {
    parameters.push({
      type: MessageParameterType.FORWARD,
      value: encodeUint8ParameterValue(0, "FORWARD"),
    });
  }

  return parameters;
}

/**
 * 純粋関数: PUBLISH の Track Properties を構築する
 *
 * draft-ietf-moq-transport-19 Section 12.1-12.6
 */
export function buildPublishTrackProperties(options?: PublishOptions): Property[] {
  const trackProperties: Property[] = [];

  // OBJECT_DELIVERY_TIMEOUT (0x02) - draft-ietf-moq-transport-19 Section 12.2 (OBJECT_DELIVERY_TIMEOUT)
  if (options?.deliveryTimeout !== undefined) {
    validateNonNegative(options.deliveryTimeout, "OBJECT_DELIVERY_TIMEOUT");
    trackProperties.push({
      id: TrackPropertyId.OBJECT_DELIVERY_TIMEOUT,
      value: options.deliveryTimeout,
    });
  }

  // SUBGROUP_DELIVERY_TIMEOUT (0x06) - draft-ietf-moq-transport-19 Section 12.1 (SUBGROUP_DELIVERY_TIMEOUT)
  if (options?.subgroupDeliveryTimeout !== undefined) {
    validateNonNegative(options.subgroupDeliveryTimeout, "SUBGROUP_DELIVERY_TIMEOUT");
    trackProperties.push({
      id: TrackPropertyId.SUBGROUP_DELIVERY_TIMEOUT,
      value: options.subgroupDeliveryTimeout,
    });
  }

  // MAX_CACHE_DURATION (0x04) - draft-ietf-moq-transport-19 Section 12.3 (MAX CACHE DURATION)
  if (options?.maxCacheDuration !== undefined) {
    validateNonNegative(options.maxCacheDuration, "MAX_CACHE_DURATION");
    trackProperties.push({
      id: TrackPropertyId.MAX_CACHE_DURATION,
      value: options.maxCacheDuration,
    });
  }

  // DEFAULT_PUBLISHER_PRIORITY (0x0e) - draft-ietf-moq-transport-19 Section 12.4 (DEFAULT PUBLISHER PRIORITY)
  if (options?.publisherPriority !== undefined) {
    if (
      options.publisherPriority < DEFAULT_PUBLISHER_PRIORITY_MIN ||
      options.publisherPriority > DEFAULT_PUBLISHER_PRIORITY_MAX
    ) {
      throw new Error(
        `DEFAULT_PUBLISHER_PRIORITY must be in range ${DEFAULT_PUBLISHER_PRIORITY_MIN}-${DEFAULT_PUBLISHER_PRIORITY_MAX}: ${options.publisherPriority}`,
      );
    }
    trackProperties.push({
      id: TrackPropertyId.DEFAULT_PUBLISHER_PRIORITY,
      value: BigInt(options.publisherPriority),
    });
  }

  // DEFAULT_PUBLISHER_GROUP_ORDER (0x22) - draft-ietf-moq-transport-19 Section 12.5 (DEFAULT PUBLISHER GROUP ORDER)
  if (options?.groupOrder !== undefined) {
    if (options.groupOrder !== "Ascending" && options.groupOrder !== "Descending") {
      throw new Error(
        `DEFAULT_PUBLISHER_GROUP_ORDER must be "Ascending" or "Descending": ${options.groupOrder as string}`,
      );
    }
    const groupOrderValue = options.groupOrder === "Ascending" ? 0x01n : 0x02n;
    trackProperties.push({
      id: TrackPropertyId.DEFAULT_PUBLISHER_GROUP_ORDER,
      value: groupOrderValue,
    });
  }

  // DYNAMIC_GROUPS (0x30) - draft-ietf-moq-transport-19 Section 12.6 (DYNAMIC GROUPS)
  if (options?.dynamicGroups === true) {
    trackProperties.push({
      id: TrackPropertyId.DYNAMIC_GROUPS,
      value: 1n,
    });
  }

  return trackProperties;
}

// ============================================================================
// SUBSCRIBE 用
// ============================================================================

/**
 * 純粋関数: SUBSCRIBE の Message Parameters を構築する
 *
 * draft-ietf-moq-transport-19 Section 10.2
 */
export function buildSubscribeParameters(options?: SubscribeOptions): Parameter[] {
  const parameters: Parameter[] = [];

  // LOCATION_FILTER (0x21) - draft-ietf-moq-transport-19 Section 10.2.9
  if (options?.filter !== undefined) {
    parameters.push(encodeLocationFilterParameter(options.filter));
  }

  // OBJECT_DELIVERY_TIMEOUT (0x02) - draft-ietf-moq-transport-19 Section 10.2.4
  if (options?.deliveryTimeout !== undefined) {
    validateNonNegative(options.deliveryTimeout, "OBJECT_DELIVERY_TIMEOUT");
    parameters.push({
      type: MessageParameterType.OBJECT_DELIVERY_TIMEOUT,
      value: encodeVarint(options.deliveryTimeout),
    });
  }

  // SUBGROUP_DELIVERY_TIMEOUT (0x06) - draft-ietf-moq-transport-19 Section 10.2.3
  if (options?.subgroupDeliveryTimeout !== undefined) {
    validateNonNegative(options.subgroupDeliveryTimeout, "SUBGROUP_DELIVERY_TIMEOUT");
    parameters.push({
      type: MessageParameterType.SUBGROUP_DELIVERY_TIMEOUT,
      value: encodeVarint(options.subgroupDeliveryTimeout),
    });
  }

  // SUBSCRIBER_PRIORITY (0x20) - draft-ietf-moq-transport-19 Section 10.2.7 (uint8)
  if (options?.subscriberPriority !== undefined) {
    parameters.push({
      type: MessageParameterType.SUBSCRIBER_PRIORITY,
      value: encodeUint8ParameterValue(options.subscriberPriority, "SUBSCRIBER_PRIORITY"),
    });
  }

  // GROUP_ORDER (0x22) - draft-ietf-moq-transport-19 Section 10.2.8 (uint8)
  if (options?.groupOrder !== undefined) {
    if (options.groupOrder !== "Ascending" && options.groupOrder !== "Descending") {
      throw new Error(
        `GROUP_ORDER must be "Ascending" or "Descending": ${options.groupOrder as string}`,
      );
    }
    const groupOrderValue = options.groupOrder === "Ascending" ? 0x01 : 0x02;
    parameters.push({
      type: MessageParameterType.GROUP_ORDER,
      value: encodeUint8ParameterValue(groupOrderValue, "GROUP_ORDER"),
    });
  }

  // NEW_GROUP_REQUEST (0x32) - draft-ietf-moq-transport-19 Section 10.2.18 (varint)
  if (options?.newGroupRequest !== undefined) {
    validateNonNegative(options.newGroupRequest, "NEW_GROUP_REQUEST");
    parameters.push({
      type: MessageParameterType.NEW_GROUP_REQUEST,
      value: encodeVarint(options.newGroupRequest),
    });
  }

  // RENDEZVOUS_TIMEOUT (0x04) - draft-ietf-moq-transport-19 Section 10.2.6
  if (options?.rendezvousTimeout !== undefined) {
    validateNonNegative(options.rendezvousTimeout, "RENDEZVOUS_TIMEOUT");
    parameters.push({
      type: MessageParameterType.RENDEZVOUS_TIMEOUT,
      value: encodeVarint(options.rendezvousTimeout),
    });
  }

  // FORWARD (0x10) - draft-ietf-moq-transport-19 Section 10.2.17 (uint8)
  // デフォルトは 1 なので、明示的に false (0) が指定された場合のみ送信
  if (options?.forward === false) {
    parameters.push({
      type: MessageParameterType.FORWARD,
      value: encodeUint8ParameterValue(0, "FORWARD"),
    });
  }

  // Range Filters (0x25–0x29) - draft-ietf-moq-transport-19 Section 5.1.3
  if (options?.rangeFilters !== undefined) {
    for (const spec of options.rangeFilters) {
      const paramType = rangeFilterTypeToParamType(spec.type);
      parameters.push({
        type: paramType,
        value: encodeRangeFilter(spec),
      });
    }
  }

  // AUTHORIZATION_TOKEN (0x03) - draft-ietf-moq-transport-19 Section 10.2.2
  // draft-ietf-moq-msf-01 §11.4.3: catalog の authInfo を見てトークンを自動付与する
  if (options?.authorizationToken !== undefined) {
    parameters.push({
      type: MessageParameterType.AUTHORIZATION_TOKEN,
      value: encodeAuthorizationToken(options.authorizationToken),
    });
  }

  return parameters;
}

/**
 * 純粋関数: SUBSCRIBE_TRACKS のパラメータを構築する
 *
 * draft-ietf-moq-transport-19 Section 10.19.1 (Parameters on SUBSCRIBE_TRACKS):
 * GROUP_ORDER (§10.2.8) と FORWARD (§10.2.17) のみ。
 */
export function buildSubscribeTracksParameters(options?: {
  groupOrder?: "Ascending" | "Descending";
  forward?: boolean;
}): Parameter[] {
  const parameters: Parameter[] = [];

  // GROUP_ORDER (0x22) - draft-ietf-moq-transport-19 Section 10.2.8 (uint8)
  if (options?.groupOrder !== undefined) {
    if (options.groupOrder !== "Ascending" && options.groupOrder !== "Descending") {
      throw new Error(
        `GROUP_ORDER must be "Ascending" or "Descending": ${options.groupOrder as string}`,
      );
    }
    const groupOrderValue = options.groupOrder === "Ascending" ? 0x01 : 0x02;
    parameters.push({
      type: MessageParameterType.GROUP_ORDER,
      value: encodeUint8ParameterValue(groupOrderValue, "GROUP_ORDER"),
    });
  }

  // FORWARD (0x10) - draft-ietf-moq-transport-19 Section 10.2.17 (uint8)
  // デフォルトは 1 なので、明示的に false (0) が指定された場合のみ送信
  if (options?.forward === false) {
    parameters.push({
      type: MessageParameterType.FORWARD,
      value: encodeUint8ParameterValue(0, "FORWARD"),
    });
  }

  return parameters;
}

// ============================================================================
// パラメータ抽出
// ============================================================================

/**
 * 純粋関数: SUBSCRIBE_OK のパラメータから LARGEST_OBJECT を抽出する
 *
 * draft-ietf-moq-transport-19 Section 10.2.16 (LARGEST OBJECT Parameter)
 */
export function extractLargestLocation(parameters: Parameter[]): Location | undefined {
  for (const param of parameters) {
    if (param.type === MessageParameterType.LARGEST_OBJECT) {
      return getParameterLocationValue(param);
    }
  }
  return undefined;
}

/**
 * 純粋関数: パラメータから FORWARD 状態を抽出する
 *
 * draft-ietf-moq-transport-19 Section 10.2.17 (FORWARD Parameter)
 * FORWARD がない場合はデフォルト値 true を返す。
 */
export function extractForwardState(parameters: Parameter[]): boolean {
  for (const param of parameters) {
    if (param.type === MessageParameterType.FORWARD) {
      const forwardValue = param.value[0];
      validateForwardValue(forwardValue);
      return forwardValue !== 0;
    }
  }
  return true;
}

// ============================================================================
// 検証
// ============================================================================

/**
 * 純粋関数: FETCH_OK の End Location 検証
 *
 * draft-ietf-moq-transport-19 Section 10.13 (FETCH_OK):
 * "If End Location is smaller than the Start Location in the
 *  corresponding FETCH the receiver MUST close the session with
 *  a PROTOCOL_VIOLATION."
 *
 * @returns 検証エラーメッセージ。問題なければ undefined。
 */
export function validateFetchOkEndLocation(
  startLocation: Location,
  endLocation: Location,
): string | undefined {
  if (
    endLocation.group < startLocation.group ||
    (endLocation.group === startLocation.group && endLocation.object < startLocation.object)
  ) {
    return `FETCH_OK end location (${endLocation.group}:${endLocation.object}) is smaller than start location (${startLocation.group}:${startLocation.object})`;
  }
  return undefined;
}

// ============================================================================
// ストリーム種別判定
// ============================================================================

/**
 * 単方向データストリームの種類
 */
export type IncomingStreamKind = "subgroup" | "fetch" | "unknown";

/**
 * 純粋関数: 単方向ストリームの先頭バイトから種別を判定する
 *
 * draft-ietf-moq-transport-19 Section 3.4, Section 11.4.2
 *
 * SUBGROUP_HEADER の type 値範囲: 0x10..0x1F, 0x30..0x3F, 0x50..0x5F, 0x70..0x7F
 *
 * draft-ietf-moq-transport-19 Section 3.4:
 * 0b0XX1XXXX のパターンに一致する全範囲を subgroup として判定する。
 * 0x50..0x5F / 0x70..0x7F は FIRST_OBJECT ビット (0x40) が設定された
 * SUBGROUP_HEADER であり、relay 経由でクライアントに配送される場合もある。
 */
export function classifyIncomingStreamType(firstByte: bigint): IncomingStreamKind {
  const streamTypeNum = Number(firstByte);

  if (streamTypeNum === FetchHeaderType) {
    return "fetch";
  }

  if (
    (streamTypeNum >= 0x10 && streamTypeNum <= 0x1f) ||
    (streamTypeNum >= 0x30 && streamTypeNum <= 0x3f) ||
    (streamTypeNum >= 0x50 && streamTypeNum <= 0x5f) ||
    (streamTypeNum >= 0x70 && streamTypeNum <= 0x7f)
  ) {
    return "subgroup";
  }

  return "unknown";
}

// ============================================================================
// Object ID Delta 計算
// ============================================================================

/**
 * 純粋関数: Object ID Delta を計算する
 *
 * draft-ietf-moq-transport-19 Section 11.4.2:
 * "The Object ID Delta + 1 is added to the previous Object ID ...
 *  The Object ID is the Object ID Delta if it's the first Object"
 *
 * @param previousObjectId - 前の Object ID。最初のオブジェクトの場合は負数
 * @param currentObjectId - 現在の Object ID
 */
export function calculateObjectIdDelta(previousObjectId: bigint, currentObjectId: bigint): bigint {
  if (previousObjectId < 0n) {
    return currentObjectId;
  }
  return currentObjectId - previousObjectId - 1n;
}

// ============================================================================
// setTimeout 遅延クランプ
// ============================================================================

// setTimeout の遅延上限 (2^31 - 1 = 2147483647 ms、約 24.8 日)。
// WHATWG HTML 仕様および主要ブラウザは 2^31 - 1 ms を超える遅延を 0 に丸めて
// 即発火するため、この値でクランプする。
const MAX_SETTIMEOUT_DELAY = 2147483647;

/**
 * 純粋関数: bigint のタイムアウト (ms) を setTimeout に安全に渡せる値にクランプする
 *
 * 2^31 - 1 を超える遅延は WHATWG HTML 仕様で 0 に丸められ即発火するため、上限で抑える。
 * GOAWAY タイムアウトには受信した GOAWAY のピア由来の値が渡るため、防御的にクランプする。
 *
 * @param timeout - クランプ対象のタイムアウト (ms)
 */
export function clampTimeoutMs(timeout: bigint): number {
  return Math.min(Number(timeout), MAX_SETTIMEOUT_DELAY);
}

/**
 * Track Namespace が namespacePrefix に前方一致するか判定する
 *
 * draft-ietf-moq-transport-19 §10.19 (SUBSCRIBE_TRACKS):
 * PUBLISH の trackNamespace が tracksSubscriptions の namespacePrefix に
 * 前方一致する場合、当該 subscription が PUBLISH を受信する対象となる。
 *
 * @param trackNamespace - PUBLISH からデコードした TrackNamespace tuple
 * @param namespacePrefix - SUBSCRIBE_TRACKS で指定した namespacePrefix (string[])
 * @returns 前方一致する場合は namespaceSuffix (string[])、一致しない場合は null
 */
export function matchNamespacePrefix(
  trackNamespace: string[],
  namespacePrefix: string[],
): string[] | null {
  if (namespacePrefix.length > trackNamespace.length) {
    return null;
  }
  for (let i = 0; i < namespacePrefix.length; i++) {
    if (trackNamespace[i] !== namespacePrefix[i]) {
      return null;
    }
  }
  return trackNamespace.slice(namespacePrefix.length);
}

/**
 * Range Filter の type 文字列を MessageParameterType に変換する
 */
function rangeFilterTypeToParamType(
  type: "subgroup" | "objectId" | "priority" | "objectProperty" | "trackProperty",
): number {
  switch (type) {
    case "subgroup":
      return MessageParameterType.SUBGROUP_FILTER;
    case "objectId":
      return MessageParameterType.OBJECTID_FILTER;
    case "priority":
      return MessageParameterType.PRIORITY_FILTER;
    case "objectProperty":
      return MessageParameterType.OBJECT_PROPERTY_FILTER;
    case "trackProperty":
      return MessageParameterType.TRACK_PROPERTY_FILTER;
    default: {
      const _exhaustive: never = type;
      return _exhaustive;
    }
  }
}
