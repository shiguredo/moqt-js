/**
 * MOQT Session の純粋関数群
 *
 * WebTransport や SessionImpl の状態に依存しない、入出力が明確な関数。
 * PBT (Property-Based Testing) の対象。
 */

import { FetchHeaderType } from "../dataStream";
import type { Parameter, Location, AuthorizationToken, RangeFilterSpec } from "../message";
import type { PublishOptions, SubscribeOptions, FetchOptions } from "../session";
import {
  MessageParameterType,
  encodeAuthorizationToken,
  encodeLocationFilterParameter,
  encodeRangeFilter,
  encodeUint8ParameterValue,
  validateForwardValue,
  getParameterLocationValue,
} from "../message";
import { encodeVarint } from "../varint";
import { TrackPropertyId, generateGreaseProperty, type Property } from "../properties";
import { LOCPropertyId } from "../loc";

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
 * ピアの MAX_FILTER_RANGES に対して Range Filter の送信が許可されるかを検証する
 *
 * draft-ietf-moq-transport-19 §10.3.1.6 (MAX FILTER RANGES):
 * "The default value is 0, so if not specified, the peer MUST NOT send
 *  any such filter parameters. If this limit is exceeded, an endpoint
 *  MUST reject this with REQUEST_ERROR with error code INVALID_FILTER."
 *
 * moqt-js はクライアントのため、送信前に throw して不正なワイヤを防ぐ。
 * REQUEST_UPDATE の削除 (Length=0) は Ranges を消費しないため除外する。
 *
 * @param rangeFilters - 送信する Range Filter 指定
 * @param peerMaxFilterRanges - ピアの MAX_FILTER_RANGES (0 = 送信禁止)
 * @param contextName - エラーメッセージ用のコンテキスト名
 */
export function validateRangeFilterLimits(
  rangeFilters: RangeFilterSpec[] | undefined,
  peerMaxFilterRanges: number,
  contextName: string,
): void {
  if (rangeFilters === undefined || rangeFilters.length === 0) {
    return;
  }
  if (peerMaxFilterRanges === 0) {
    throw new Error(
      `cannot send range filters in ${contextName}: peer MAX_FILTER_RANGES is 0 (not advertised)`,
    );
  }
  const totalRanges = rangeFilters.reduce(
    (sum, f) => sum + ("ranges" in f ? f.ranges.length : 0),
    0,
  );
  if (totalRanges > peerMaxFilterRanges) {
    throw new Error(
      `cannot send range filters in ${contextName}: total ranges ${totalRanges} exceeds peer MAX_FILTER_RANGES ${peerMaxFilterRanges}`,
    );
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
// Track Namespace 送信検証
// ============================================================================

/**
 * 送信前に Track Namespace が予約 namespace に該当しないことを検証する
 *
 * draft-ietf-moq-transport-19 §3.2.1 (Reserved Namespaces):
 * "MOQT reserves all Track Namespace values whose first tuple field
 *  begins with a period (0x2e, .). These namespaces MUST NOT be used
 *  unless their meaning is defined through IANA registration."
 * また先頭フィールドが "." 単体の namespace は "MUST NOT be used for any purpose"。
 *
 * draft-ietf-moq-transport-19 §3.2.2 (Session-Level Tracks and Namespaces):
 * "The Application MUST NOT publish tracks or namespaces whose first field
 *  is .session."
 * "A request with a Track Namespace whose first field is .session and an
 *  empty Track Name MUST be rejected with DOES_NOT_EXIST."
 *
 * moqt-js はクライアント実装であり IANA 登録済みの予約 namespace を定義しないため、
 * 先頭フィールドが "." で始まるすべての namespace (".session" 含む) を送信対象として
 * 拒否する。拒否は送信前の同期 throw であり、アプリケーションの入力ミスとして
 * セッションは閉じない (プロトコル違反ではない)。
 *
 * @param namespace - 送信対象の Track Namespace (string[])
 * @param trackName - Track Name。namespace スコープ外のリクエスト (SUBSCRIBE_NAMESPACE /
 *                    SUBSCRIBE_TRACKS / PUBLISH_NAMESPACE) では省略する
 * @throws Error 予約 namespace / session-level namespace の場合
 */
export function validateTrackNamespaceForSend(namespace: string[], trackName?: string): void {
  if (namespace.length === 0) {
    return;
  }
  const first = namespace[0];
  if (!first.startsWith(".")) {
    return;
  }
  if (first === ".session") {
    if (trackName === "") {
      throw new Error(
        "track with .session namespace and empty track name does not exist (DOES_NOT_EXIST)",
      );
    }
    throw new Error(
      "session-level namespace .session is reserved for the MOQT implementation (MUST NOT be used by applications)",
    );
  }
  throw new Error(
    `reserved namespace prefix ${first} is not allowed (MUST NOT be used without IANA registration)`,
  );
}

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
 *
 * @param options - PUBLISH オプション
 * @param grease - true のとき GREASE Property（§14）を 1 つ追加する。既定（未指定 / false）では追加しない。
 */
export function buildPublishTrackProperties(
  options?: PublishOptions,
  grease?: boolean,
): Property[] {
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

  // LOC TIMESCALE (0x08) - draft-ietf-moq-loc-04 Table 1 (Scope: Track, Object)
  // 偶数 ID のため value 形式。Track 初期化時に広告し Object 単位の冗長送信を削減する。
  if (options?.locTimescale !== undefined) {
    validateNonNegative(options.locTimescale, "LOC TIMESCALE");
    trackProperties.push({
      id: LOCPropertyId.TIMESCALE,
      value: options.locTimescale,
    });
  }

  // LOC VIDEO_CONFIG (0x0D) - draft-ietf-moq-loc-04 Table 1 (Scope: Track, Object)
  // 奇数 ID のため data 形式。
  if (options?.locVideoConfig !== undefined) {
    trackProperties.push({
      id: LOCPropertyId.VIDEO_CONFIG,
      data: options.locVideoConfig,
    });
  }

  // LOC AUDIO_CONFIG (0x0F) - draft-ietf-moq-loc-04 Table 1 (Scope: Track, Object)
  // 奇数 ID のため data 形式。
  if (options?.locAudioConfig !== undefined) {
    trackProperties.push({
      id: LOCPropertyId.AUDIO_CONFIG,
      data: options.locAudioConfig,
    });
  }

  // GREASE Property - draft-ietf-moq-transport-19 §14 (Grease)
  // opt-in 時、0x7f * N + 0x9D パターンの予約値を 1 つ追加する。対向が未知の Property を
  // gracefully に扱えることを保証する。encodeProperties の delta encoding / 昇順ソートは
  // GREASE Property も他 Property と同様に扱うだけで壊れない。
  if (grease === true) {
    trackProperties.push(generateGreaseProperty());
  }

  return trackProperties;
}

// ============================================================================
// SUBSCRIBE 用
// ============================================================================

/**
 * 純粋関数: Range Filter 指定を Message Parameter 配列に変換する
 *
 * draft-ietf-moq-transport-19 Section 5.1.3 (Range Filters):
 * SUBSCRIBE / SUBSCRIBE_TRACKS / PUBLISH_OK / REQUEST_UPDATE で共通のワイヤ形式。
 *
 * @param rangeFilters - Range Filter 指定（追加または削除）
 */
export function buildRangeFilterParameters(rangeFilters: RangeFilterSpec[]): Parameter[] {
  const parameters: Parameter[] = [];
  for (const spec of rangeFilters) {
    const paramType = rangeFilterTypeToParamType(spec.type);
    parameters.push({
      type: paramType,
      value: encodeRangeFilter(spec),
    });
  }
  return parameters;
}

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
    parameters.push(...buildRangeFilterParameters(options.rangeFilters));
  }

  // AUTHORIZATION_TOKEN (0x03) - draft-ietf-moq-transport-19 Section 10.2.2
  // draft-ietf-moq-msf-01 §11.4.3: track に関連するトークンは SUBSCRIBE に MUST 付与。
  if (options?.authorizationToken !== undefined) {
    parameters.push(encodeAuthorizationTokenParameter(options.authorizationToken));
  }

  return parameters;
}

/**
 * 純粋関数: AUTHORIZATION_TOKEN Message Parameter を構築する
 *
 * draft-ietf-moq-transport-19 Section 10.2.2 (AUTHORIZATION TOKEN Parameter):
 * Parameter Type 0x03、Length-prefixed encoding。値は Token 構造。
 * SETUP とは異なり Message Parameter では Alias Type DELETE / USE_ALIAS も許可される。
 */
export function encodeAuthorizationTokenParameter(token: AuthorizationToken): Parameter {
  return {
    type: MessageParameterType.AUTHORIZATION_TOKEN,
    value: encodeAuthorizationToken(token),
  };
}

/**
 * 純粋関数: FETCH の Message Parameters を構築する
 *
 * draft-ietf-moq-transport-19 Section 10.13 (FETCH)
 */
export function buildFetchParameters(options?: FetchOptions): Parameter[] {
  const parameters: Parameter[] = [];

  // FILL_TIMEOUT (0x0a) - draft-ietf-moq-transport-19 Section 10.2.5
  if (options?.fillTimeout !== undefined) {
    validateNonNegative(options.fillTimeout, "FILL_TIMEOUT");
    parameters.push({
      type: MessageParameterType.FILL_TIMEOUT,
      value: encodeVarint(options.fillTimeout),
    });
  }

  // AUTHORIZATION_TOKEN (0x03) - draft-ietf-moq-transport-19 Section 10.2.2
  // draft-ietf-moq-msf-01 §11.4.3: track に関連するトークンは FETCH に MUST 付与。
  if (options?.authorizationToken !== undefined) {
    parameters.push(encodeAuthorizationTokenParameter(options.authorizationToken));
  }

  return parameters;
}

/**
 * 純粋関数: SUBSCRIBE_NAMESPACE の Message Parameters を構築する
 *
 * draft-ietf-moq-transport-19 Section 10.18 (SUBSCRIBE_NAMESPACE)
 */
export function buildSubscribeNamespaceParameters(options?: {
  authorizationToken?: AuthorizationToken;
}): Parameter[] {
  const parameters: Parameter[] = [];

  // AUTHORIZATION_TOKEN (0x03) - draft-ietf-moq-transport-19 Section 10.2.2
  // draft-ietf-moq-msf-01 §11.4.3: track に関連するトークンは SUBSCRIBE_NAMESPACE に MUST 付与。
  if (options?.authorizationToken !== undefined) {
    parameters.push(encodeAuthorizationTokenParameter(options.authorizationToken));
  }

  return parameters;
}

/**
 * 純粋関数: SUBSCRIBE_TRACKS のパラメータを構築する
 *
 * draft-ietf-moq-transport-19 Section 10.19.1 (Parameters on SUBSCRIBE_TRACKS):
 * "Any Parameter that can be specified on a Subscription (ie: in SUBSCRIBE) is
 *  valid in SUBSCRIBE_TRACKS, unless otherwise specified."
 *
 * draft-ietf-moq-transport-19 Section 6.3 (Filtering SUBSCRIBE_TRACKS):
 * "Range Filters Section 5.1.3 can be used in SUBSCRIBE_TRACKS to filter
 *  Tracks in a namespace using the Track Property Filter."
 */
export function buildSubscribeTracksParameters(options?: {
  groupOrder?: "Ascending" | "Descending";
  forward?: boolean;
  rangeFilters?: RangeFilterSpec[];
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

  // Range Filters (0x25–0x29) - draft-ietf-moq-transport-19 Section 5.1.3 / 6.3
  if (options?.rangeFilters !== undefined) {
    parameters.push(...buildRangeFilterParameters(options.rangeFilters));
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
 * 純粋関数: Location の大小比較
 *
 * draft-ietf-moq-transport-19 §1.4.2 (Location Structure):
 * "Location A < Location B if:
 *  A.Group < B.Group || (A.Group == B.Group && A.Object < B.Object)"
 *
 * @returns a < b なら負、a == b なら 0、a > b なら正
 */
export function compareLocations(a: Location, b: Location): number {
  if (a.group !== b.group) {
    return a.group < b.group ? -1 : 1;
  }
  if (a.object !== b.object) {
    return a.object < b.object ? -1 : 1;
  }
  return 0;
}

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
  if (compareLocations(endLocation, startLocation) < 0) {
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
 * 2 つの Track Namespace Prefix が共通の prefix を持つか判定する
 *
 * draft-ietf-moq-transport-19 §10.9.2 (Updating Namespace Subscriptions):
 * "the new prefix MUST NOT share a common prefix with any other active
 *  SUBSCRIBE_NAMESPACE (for a SUBSCRIBE_NAMESPACE update) or SUBSCRIBE_TRACKS
 *  (for a SUBSCRIBE_TRACKS update) in the same session."
 *
 * 共通 prefix を持つとは、一方が他方の sub-prefix (前方一致) であること。
 * 片方向の matchNamespacePrefix では判定できないため、双方向を確認する。
 *
 * @param a - 比較する Track Namespace Prefix
 * @param b - 比較する Track Namespace Prefix
 * @returns 一方が他方の sub-prefix の場合は true
 */
export function namespacePrefixesOverlap(a: string[], b: string[]): boolean {
  if (matchNamespacePrefix(b, a) !== null) {
    return true;
  }
  return matchNamespacePrefix(a, b) !== null;
}

/**
 * 更新後の Track Namespace Prefix が既存のアクティブなサブスクリプションと
 * 共通 prefix を持たないことを検証する
 *
 * draft-ietf-moq-transport-19 §10.9.2 (Updating Namespace Subscriptions):
 * "The overlap restriction applies independently per type: the new prefix
 *  MUST NOT share a common prefix with any other active SUBSCRIBE_NAMESPACE
 *  (for a SUBSCRIBE_NAMESPACE update) or SUBSCRIBE_TRACKS (for a
 *  SUBSCRIBE_TRACKS update) in the same session."
 *
 * 送信前のクライアント側先行検証であり、仕様の MUST は受信側の
 * REQUEST_ERROR (PREFIX_OVERLAP) 応答 (§10.2.19) である。
 * 検証失敗時は throw する (セッションは閉じない)。
 *
 * @param newPrefix - 更新後の Track Namespace Prefix
 * @param activePrefixes - 同一型のアクティブなサブスクリプションの prefix 一覧
 *                         (更新対象自身は含めない。含めると prefix 拡大更新を
 *                         誤って拒否するため)
 * @param contextName - エラーメッセージ用のコンテキスト名
 * @throws Error 共通 prefix を持つ既存のアクティブなサブスクリプションがある場合
 */
export function validateNamespacePrefixUpdate(
  newPrefix: string[],
  activePrefixes: string[][],
  contextName: string,
): void {
  for (const activePrefix of activePrefixes) {
    if (namespacePrefixesOverlap(newPrefix, activePrefix)) {
      throw new Error(
        `cannot update ${contextName} track namespace prefix: new prefix ${JSON.stringify(newPrefix)} overlaps with active subscription prefix ${JSON.stringify(activePrefix)}`,
      );
    }
  }
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
