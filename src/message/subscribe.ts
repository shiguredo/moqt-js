/**
 * MOQT Subscribe Messages
 * draft-ietf-moq-transport-18 Section 10.7 (SUBSCRIBE) — 10.8 (SUBSCRIBE_OK) — 10.9 (REQUEST_UPDATE)
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
 * SUBSCRIBE メッセージ (Section 10.7 SUBSCRIBE)
 *
 * draft-ietf-moq-transport-18:
 * SUBSCRIBE does NOT include Track Alias.
 * Track Alias is returned by the publisher in SUBSCRIBE_OK.
 */
export interface Subscribe {
  type: typeof MessageType.SUBSCRIBE;
  requestId: bigint;
  trackNamespace: TrackNamespace;
  trackName: Uint8Array;
  parameters: Parameter[];
}

/**
 * SUBSCRIBE_OK メッセージ (Section 10.8 SUBSCRIBE_OK)
 *
 * draft-ietf-moq-transport-18:
 * - 双方向ストリーム上で送信されるため Request ID は不要。
 * - Track Properties が追加された。
 * draft-ietf-moq-transport-18 Section 10 (Control Messages)
 */
export interface SubscribeOk {
  type: typeof MessageType.SUBSCRIBE_OK;
  trackAlias: bigint;
  parameters: Parameter[];
  trackProperties: Property[];
}

/**
 * REQUEST_UPDATE メッセージ (Section 10.9 REQUEST_UPDATE)
 *
 * draft-ietf-moq-transport-18:
 * 既存のリクエスト（SUBSCRIBE, PUBLISH, FETCH など）の
 * パラメータを後から変更するために使用する。
 * 更新対象のリクエストは同じ bidi stream で特定される。
 */
export interface RequestUpdate {
  type: typeof MessageType.REQUEST_UPDATE;
  requestId: bigint;
  parameters: Parameter[];
}

/**
 * Subscribe のペイロードをエンコード
 *
 * draft-ietf-moq-transport-18 Section 10.7 (SUBSCRIBE):
 * SUBSCRIBE Message {
 *   Type (i) = 0x3,
 *   Length (16),
 *   Request ID (i),
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
 *
 * draft-ietf-moq-transport-18 Section 10.8 (SUBSCRIBE_OK):
 * SUBSCRIBE_OK Message {
 *   Type (i) = 0x4,
 *   Length (16),
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

  // draft-ietf-moq-transport-18 Section 10.8 (SUBSCRIBE_OK):
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

  // draft-ietf-moq-transport-18 Section 10.8 (SUBSCRIBE_OK):
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
 * draft-ietf-moq-transport-18 Section 10.9 (REQUEST_UPDATE):
 * REQUEST_UPDATE Message {
 *   Type (i) = 0x2,
 *   Length (16),
 *   Request ID (vi64),
 *   Number of Parameters (vi64),
 *   Parameters (..) ...
 * }
 */
export function encodeRequestUpdatePayload(msg: RequestUpdate): Uint8Array {
  const parts: Uint8Array[] = [];

  parts.push(encodeVarint(msg.requestId));
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
 * PBT（Property-Based Testing）でのラウンドトリップテストで使用。
 */
export function decodeRequestUpdatePayload(data: Uint8Array, offset = 0): RequestUpdate {
  let totalConsumed = 0;

  const [requestId, requestIdConsumed] = decodeVarint(data, offset + totalConsumed);
  totalConsumed += requestIdConsumed;

  const [parameters, paramsConsumed] = decodeParameters(data, offset + totalConsumed);
  totalConsumed += paramsConsumed;

  return {
    type: MessageType.REQUEST_UPDATE,
    requestId,
    parameters,
  };
}
