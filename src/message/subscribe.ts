/**
 * MOQT Subscribe Messages
 * draft-ietf-moq-transport-20 Section 10.7 (SUBSCRIBE) — 10.8 (SUBSCRIBE_OK) — 10.9 (REQUEST_UPDATE)
 */

import { decodeVarint, encodeVarint } from "../varint";
import { ProtocolViolationError } from "../error";
import { type Property, decodeProperties, encodeProperties } from "../properties";
import {
  type Parameter,
  type TrackNamespace,
  decodeParameters,
  decodeTrackNamespace,
  encodeParameters,
  encodeTrackNamespace,
  validateFullTrackNameBytes,
} from "./parameter";
import { MessageType } from "./types";

/**
 * SUBSCRIBE メッセージ (Section 10.7 SUBSCRIBE)
 *
 * draft-ietf-moq-transport-20:
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
 * draft-ietf-moq-transport-20:
 * - 双方向ストリーム上で送信されるため Request ID は不要。
 * - Track Properties が追加された。
 * draft-ietf-moq-transport-20 Section 10 (Control Messages)
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
 * draft-ietf-moq-transport-20:
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
 * draft-ietf-moq-transport-20 Section 10.7 (SUBSCRIBE):
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

  // draft-ietf-moq-transport-20 §2.4.1:
  // Full Track Name (Namespace + Track Name 合計) が 4096 バイト超過は PROTOCOL_VIOLATION
  // ワイヤバイト長で計測する (不正 UTF-8 の置換による誤計測を防ぐ)
  validateFullTrackNameBytes(trackNamespace, trackName);

  const [parameters, paramsConsumed] = decodeParameters(data, offset + totalConsumed);
  totalConsumed += paramsConsumed;

  // draft-ietf-moq-transport-20 Section 10:
  // "If the length does not match the length of the Message Body,
  //  the receiver MUST close the session with a PROTOCOL_VIOLATION."
  // Parameters は SUBSCRIBE ペイロードの最後のフィールドであり、
  // その後ろに後続データがあると消費バイト数が Message Body 長と一致しないため違反となる
  if (offset + totalConsumed !== data.length) {
    throw new ProtocolViolationError(
      `trailing data in SUBSCRIBE: expected ${data.length} bytes, consumed ${offset + totalConsumed}`,
    );
  }

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
 * draft-ietf-moq-transport-20 Section 10.8 (SUBSCRIBE_OK):
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

  // draft-ietf-moq-transport-20 Section 10.8 (SUBSCRIBE_OK):
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

  // draft-ietf-moq-transport-20 Section 10.8 (SUBSCRIBE_OK):
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
 * draft-ietf-moq-transport-20 Section 10.9 (REQUEST_UPDATE):
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
 * 以下の受信 REQUEST_UPDATE 経路で使用する:
 * - 受信 PUBLISH ストリーム上での REQUEST_UPDATE (ピア Publisher からの update、
 *   bidiHandlePublishRequestUpdate)
 * - 送信 PUBLISH の bidi ストリーム上での REQUEST_UPDATE (ピア Subscriber からの update、
 *   bidiReadRequestStreamMessages 内)
 * PBT（Property-Based Testing）でのラウンドトリップテストでも使用。
 */
export function decodeRequestUpdatePayload(data: Uint8Array, offset = 0): RequestUpdate {
  let totalConsumed = 0;

  const [requestId, requestIdConsumed] = decodeVarint(data, offset + totalConsumed);
  totalConsumed += requestIdConsumed;

  const [parameters, paramsConsumed] = decodeParameters(data, offset + totalConsumed);
  totalConsumed += paramsConsumed;

  // draft-ietf-moq-transport-20 Section 10:
  // "If the length does not match the length of the Message Body,
  //  the receiver MUST close the session with a PROTOCOL_VIOLATION."
  // Parameters は REQUEST_UPDATE ペイロードの最後のフィールドであり、
  // その後ろに後続データがあると消費バイト数が Message Body 長と一致しないため違反となる
  if (offset + totalConsumed !== data.length) {
    throw new ProtocolViolationError(
      `trailing data in REQUEST_UPDATE: expected ${data.length} bytes, consumed ${offset + totalConsumed}`,
    );
  }

  return {
    type: MessageType.REQUEST_UPDATE,
    requestId,
    parameters,
  };
}
