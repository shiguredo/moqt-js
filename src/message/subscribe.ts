/**
 * MOQT Subscribe Messages
 * draft-ietf-moq-transport-17 Section 9.9-9.12
 */

import { decodeVarint, encodeVarint } from "../varint";
import { type Property, decodeProperties, encodeProperties } from "../properties";
import {
  type Parameter,
  type TrackNamespace,
  decodeParameters,
  decodeTrackNamespace,
  encodeParameters,
  encodeTrackNamespace,
} from "./parameter";
import { MessageType } from "./types";

/**
 * SUBSCRIBE メッセージ (Section 9.9)
 *
 * draft-ietf-moq-transport-16:
 * SUBSCRIBE does NOT include Track Alias.
 * Track Alias is returned by the publisher in SUBSCRIBE_OK.
 */
export interface Subscribe {
  type: typeof MessageType.SUBSCRIBE;
  requestId: bigint;
  // Required Request ID Delta (vi64) - draft-ietf-moq-transport-17 Section 9.2
  // 0 は依存なしを意味する
  requiredRequestIdDelta: bigint;
  trackNamespace: TrackNamespace;
  trackName: Uint8Array;
  parameters: Parameter[];
}

/**
 * SUBSCRIBE_OK メッセージ (Section 9.10)
 *
 * draft-ietf-moq-transport-16:
 * Track Extensions が追加された。
 * https://github.com/moq-wg/moq-transport/pull/1374
 */
/**
 * draft-ietf-moq-transport-17 Section 9.9:
 * 双方向ストリーム上で送信されるため Request ID は不要。
 */
export interface SubscribeOk {
  type: typeof MessageType.SUBSCRIBE_OK;
  trackAlias: bigint;
  parameters: Parameter[];
  trackProperties: Property[];
}

/**
 * REQUEST_UPDATE メッセージ (Section 9.10)
 *
 * draft-ietf-moq-transport-17:
 * 既存のリクエスト（SUBSCRIBE, PUBLISH, FETCH など）の
 * パラメータを後から変更するために使用する。
 * 更新対象のリクエストは同じ bidi stream で特定される。
 */
export interface RequestUpdate {
  type: typeof MessageType.REQUEST_UPDATE;
  requestId: bigint;
  // Required Request ID Delta (vi64) - draft-ietf-moq-transport-17 Section 9.2
  // 0 は依存なしを意味する
  requiredRequestIdDelta: bigint;
  parameters: Parameter[];
}

/**
 * UNSUBSCRIBE メッセージ (Section 9.12)
 */
export interface Unsubscribe {
  type: typeof MessageType.UNSUBSCRIBE;
  requestId: bigint;
}

/**
 * Subscribe のペイロードをエンコード
 *
 * draft-ietf-moq-transport-17 Section 9.9:
 * SUBSCRIBE Message {
 *   Type (i) = 0x3,
 *   Length (16),
 *   Request ID (i),
 *   Required Request ID Delta (i),
 *   Track Namespace (..),
 *   Track Name Length (i),
 *   Track Name (..),
 *   Number of Parameters (i),
 *   Parameters (..) ...
 * }
 */
export function encodeSubscribePayload(msg: Subscribe): Uint8Array {
  const parts: Uint8Array[] = [];

  parts.push(encodeVarint(msg.requestId));
  parts.push(encodeVarint(msg.requiredRequestIdDelta));
  parts.push(encodeTrackNamespace(msg.trackNamespace));
  parts.push(encodeVarint(msg.trackName.length));
  parts.push(msg.trackName);
  parts.push(encodeParameters(msg.parameters));

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
 * Subscribe のペイロードをデコード
 *
 * リレーサーバー実装用。moqt-js はクライアント専用のため、ランタイムでは使用しない。
 * PBT（Property-Based Testing）でのラウンドトリップテストで使用。
 */
export function decodeSubscribePayload(data: Uint8Array, offset = 0): Subscribe {
  let totalConsumed = 0;

  const [requestId, requestIdConsumed] = decodeVarint(data, offset + totalConsumed);
  totalConsumed += requestIdConsumed;

  const [requiredRequestIdDelta, requiredRequestIdDeltaConsumed] = decodeVarint(
    data,
    offset + totalConsumed,
  );
  totalConsumed += requiredRequestIdDeltaConsumed;

  const [trackNamespace, namespaceConsumed] = decodeTrackNamespace(data, offset + totalConsumed);
  totalConsumed += namespaceConsumed;

  const [nameLen, nameLenConsumed] = decodeVarint(data, offset + totalConsumed);
  totalConsumed += nameLenConsumed;
  const trackName = data.slice(offset + totalConsumed, offset + totalConsumed + Number(nameLen));
  totalConsumed += Number(nameLen);

  const [parameters, paramsConsumed] = decodeParameters(data, offset + totalConsumed);
  totalConsumed += paramsConsumed;

  return {
    type: MessageType.SUBSCRIBE,
    requestId,
    requiredRequestIdDelta,
    trackNamespace,
    trackName,
    parameters,
  };
}

/**
 * SubscribeOk のペイロードをエンコード
 *
 * リレーサーバー実装用。moqt-js はクライアント専用のため、ランタイムでは使用しない。
 * PBT（Property-Based Testing）でのラウンドトリップテストで使用。
 */
/**
 * draft-ietf-moq-transport-16 Section 9.10:
 * SUBSCRIBE_OK Message {
 *   Type (i) = 0x4,
 *   Length (16),
 *   Request ID (i),
 *   Track Alias (i),
 *   Number of Parameters (i),
 *   Parameters (..) ...,
 *   Track Properties (..)
 * }
 */
export function encodeSubscribeOkPayload(msg: SubscribeOk): Uint8Array {
  const parts: Uint8Array[] = [];

  parts.push(encodeVarint(msg.trackAlias));
  parts.push(encodeParameters(msg.parameters));

  // draft-ietf-moq-transport-17 Section 9.9:
  // Track Properties は length プレフィックスなしでシリアライズされる。
  parts.push(encodeProperties(msg.trackProperties));

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
 * SubscribeOk のペイロードをデコード
 */
export function decodeSubscribeOkPayload(data: Uint8Array, offset = 0): SubscribeOk {
  let totalConsumed = 0;

  const [trackAlias, trackAliasConsumed] = decodeVarint(data, offset + totalConsumed);
  totalConsumed += trackAliasConsumed;

  const [parameters, paramsConsumed] = decodeParameters(data, offset + totalConsumed);
  totalConsumed += paramsConsumed;

  // draft-ietf-moq-transport-17 Section 9.9:
  // Track Properties は残りバイトすべて
  const propertiesData = data.slice(offset + totalConsumed);
  const trackProperties = decodeProperties(propertiesData);

  return {
    type: MessageType.SUBSCRIBE_OK,
    trackAlias,
    parameters,
    trackProperties,
  };
}

/**
 * RequestUpdate のペイロードをエンコード
 *
 * draft-ietf-moq-transport-16 Section 9.11:
 * REQUEST_UPDATE Message {
 *   Type (i) = 0x2,
 *   Length (16),
 *   Request ID (vi64),
 *   Required Request ID Delta (vi64),
 *   Number of Parameters (vi64),
 *   Parameters (..) ...
 * }
 */
export function encodeRequestUpdatePayload(msg: RequestUpdate): Uint8Array {
  const parts: Uint8Array[] = [];

  parts.push(encodeVarint(msg.requestId));
  parts.push(encodeVarint(msg.requiredRequestIdDelta));
  parts.push(encodeParameters(msg.parameters));

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
 * RequestUpdate のペイロードをデコード
 *
 * リレーサーバーおよび Publisher 実装用。
 * moqt-js はクライアント専用のため、現在ランタイムでは使用しない。
 * TODO: Publisher として REQUEST_UPDATE を受信する処理の実装。
 * PBT（Property-Based Testing）でのラウンドトリップテストで使用。
 */
export function decodeRequestUpdatePayload(data: Uint8Array, offset = 0): RequestUpdate {
  let totalConsumed = 0;

  const [requestId, requestIdConsumed] = decodeVarint(data, offset + totalConsumed);
  totalConsumed += requestIdConsumed;

  const [requiredRequestIdDelta, requiredRequestIdDeltaConsumed] = decodeVarint(
    data,
    offset + totalConsumed,
  );
  totalConsumed += requiredRequestIdDeltaConsumed;

  const [parameters, paramsConsumed] = decodeParameters(data, offset + totalConsumed);
  totalConsumed += paramsConsumed;

  return {
    type: MessageType.REQUEST_UPDATE,
    requestId,
    requiredRequestIdDelta,
    parameters,
  };
}

/**
 * Unsubscribe のペイロードをエンコード
 */
export function encodeUnsubscribePayload(msg: Unsubscribe): Uint8Array {
  return encodeVarint(msg.requestId);
}

/**
 * Unsubscribe のペイロードをデコード
 *
 * リレーサーバー実装用。moqt-js はクライアント専用のため、ランタイムでは使用しない。
 * PBT（Property-Based Testing）でのラウンドトリップテストで使用。
 */
export function decodeUnsubscribePayload(data: Uint8Array, offset = 0): Unsubscribe {
  const [requestId] = decodeVarint(data, offset);
  return {
    type: MessageType.UNSUBSCRIBE,
    requestId,
  };
}
