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
  encodeSubscriptionFilterParameter,
  encodeUint8ParameterValue,
  validateForwardValue,
  getParameterLocationValue,
} from "../message";
import { encodeVarint } from "../varint";
import { TrackPropertyId, type Property } from "../properties";

// ============================================================================
// PUBLISH 用
// ============================================================================

/**
 * 純粋関数: PUBLISH の Message Parameters を構築する
 *
 * draft-ietf-moq-transport-17 Section 9.3
 */
export function buildPublishParameters(options?: PublishOptions): Parameter[] {
  const parameters: Parameter[] = [];

  // EXPIRES (0x08) - draft-ietf-moq-transport-17 Section 9.3.8 (EXPIRES Parameter)
  if (options?.expires !== undefined) {
    parameters.push({
      type: MessageParameterType.EXPIRES,
      value: encodeVarint(options.expires),
    });
  }

  // FORWARD (0x10) - draft-ietf-moq-transport-17 Section 9.3.10 (FORWARD Parameter)
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
 * draft-ietf-moq-transport-17 Section 11.1-11.5
 */
export function buildPublishTrackProperties(options?: PublishOptions): Property[] {
  const trackProperties: Property[] = [];

  // DELIVERY_TIMEOUT (0x02) - draft-ietf-moq-transport-17 Section 11.1 (DELIVERY TIMEOUT)
  if (options?.deliveryTimeout !== undefined) {
    trackProperties.push({
      id: TrackPropertyId.DELIVERY_TIMEOUT,
      value: options.deliveryTimeout,
    });
  }

  // MAX_CACHE_DURATION (0x04) - draft-ietf-moq-transport-17 Section 11.2 (MAX CACHE DURATION)
  if (options?.maxCacheDuration !== undefined) {
    trackProperties.push({
      id: TrackPropertyId.MAX_CACHE_DURATION,
      value: options.maxCacheDuration,
    });
  }

  // DEFAULT_PUBLISHER_PRIORITY (0x0e) - draft-ietf-moq-transport-17 Section 11.3 (DEFAULT PUBLISHER PRIORITY)
  if (options?.publisherPriority !== undefined) {
    trackProperties.push({
      id: TrackPropertyId.DEFAULT_PUBLISHER_PRIORITY,
      value: BigInt(options.publisherPriority),
    });
  }

  // DEFAULT_PUBLISHER_GROUP_ORDER (0x22) - draft-ietf-moq-transport-17 Section 11.4 (DEFAULT PUBLISHER GROUP ORDER)
  if (options?.groupOrder !== undefined) {
    const groupOrderValue = options.groupOrder === "Ascending" ? 0x01n : 0x02n;
    trackProperties.push({
      id: TrackPropertyId.DEFAULT_PUBLISHER_GROUP_ORDER,
      value: groupOrderValue,
    });
  }

  // DYNAMIC_GROUPS (0x30) - draft-ietf-moq-transport-17 Section 11.5 (DYNAMIC GROUPS)
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
 * draft-ietf-moq-transport-17 Section 9.3
 */
export function buildSubscribeParameters(options?: SubscribeOptions): Parameter[] {
  const parameters: Parameter[] = [];

  // SUBSCRIPTION_FILTER (0x21) - draft-ietf-moq-transport-17 Section 9.3.7
  if (options?.filter !== undefined) {
    parameters.push(encodeSubscriptionFilterParameter(options.filter));
  }

  // DELIVERY_TIMEOUT (0x02) - draft-ietf-moq-transport-17 Section 9.3.3
  if (options?.deliveryTimeout !== undefined) {
    parameters.push({
      type: MessageParameterType.DELIVERY_TIMEOUT,
      value: encodeVarint(options.deliveryTimeout),
    });
  }

  // SUBSCRIBER_PRIORITY (0x20) - draft-ietf-moq-transport-17 Section 9.3.5 (uint8)
  if (options?.subscriberPriority !== undefined) {
    parameters.push({
      type: MessageParameterType.SUBSCRIBER_PRIORITY,
      value: encodeUint8ParameterValue(options.subscriberPriority, "SUBSCRIBER_PRIORITY"),
    });
  }

  // GROUP_ORDER (0x22) - draft-ietf-moq-transport-17 Section 9.3.6 (uint8)
  if (options?.groupOrder !== undefined) {
    const groupOrderValue = options.groupOrder === "Ascending" ? 0x01 : 0x02;
    parameters.push({
      type: MessageParameterType.GROUP_ORDER,
      value: encodeUint8ParameterValue(groupOrderValue, "GROUP_ORDER"),
    });
  }

  // NEW_GROUP_REQUEST (0x32) - draft-ietf-moq-transport-17 Section 9.3.11 (varint)
  if (options?.newGroupRequest !== undefined) {
    parameters.push({
      type: MessageParameterType.NEW_GROUP_REQUEST,
      value: encodeVarint(options.newGroupRequest),
    });
  }

  // RENDEZVOUS_TIMEOUT (0x04) - draft-ietf-moq-transport-17 Section 9.3.4
  if (options?.rendezvousTimeout !== undefined) {
    parameters.push({
      type: MessageParameterType.RENDEZVOUS_TIMEOUT,
      value: encodeVarint(options.rendezvousTimeout),
    });
  }

  // FORWARD (0x10) - draft-ietf-moq-transport-17 Section 9.3.10 (uint8)
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
 * draft-ietf-moq-transport-17 Section 9.3.9 (LARGEST OBJECT Parameter)
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
 * draft-ietf-moq-transport-17 Section 9.3.10 (FORWARD Parameter)
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
 * draft-ietf-moq-transport-17 Section 9.15 (FETCH_OK):
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
 * draft-ietf-moq-transport-17 Section 3.4, Section 10.4
 */
export function classifyIncomingStreamType(firstByte: bigint): IncomingStreamKind {
  const streamTypeNum = Number(firstByte);

  if (streamTypeNum === FetchHeaderType) {
    return "fetch";
  }

  if (
    (streamTypeNum >= 0x10 && streamTypeNum <= 0x1f) ||
    (streamTypeNum >= 0x30 && streamTypeNum <= 0x3f)
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
 * draft-ietf-moq-transport-17 Section 10.4.2:
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
