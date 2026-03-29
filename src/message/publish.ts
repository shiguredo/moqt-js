/**
 * MOQT Publish Messages
 * draft-ietf-moq-transport-17 Section 9.13-9.15
 */

import { decodeVarint, encodeVarint } from "../varint";
import { type Property, decodeProperties, encodeProperties } from "../properties";
import {
  MAX_REASON_PHRASE_LENGTH,
  type Parameter,
  type TrackNamespace,
  decodeParameters,
  decodeTrackNamespace,
  encodeParameters,
  encodeTrackNamespace,
} from "./parameter";
import { MessageType } from "./types";

/**
 * PUBLISH メッセージ (Section 9.13)
 *
 * draft-ietf-moq-transport-17:
 * Track Extensions が追加された。
 * https://github.com/moq-wg/moq-transport/pull/1374
 */
export interface Publish {
  type: typeof MessageType.PUBLISH;
  requestId: bigint;
  // Required Request ID Delta (vi64) - draft-ietf-moq-transport-17 Section 9.2
  // 0 は依存なしを意味する
  requiredRequestIdDelta: bigint;
  trackNamespace: TrackNamespace;
  trackName: Uint8Array;
  trackAlias: bigint;
  parameters: Parameter[];
  trackProperties: Property[];
}

/**
 * PUBLISH_OK メッセージ (Section 9.12)
 *
 * draft-ietf-moq-transport-17:
 * 双方向ストリーム上で送信されるため Request ID は不要。
 */
export interface PublishOk {
  type: typeof MessageType.PUBLISH_OK;
  parameters: Parameter[];
}

/**
 * PUBLISH_DONE メッセージ (Section 9.13)
 *
 * draft-ietf-moq-transport-17:
 * 双方向ストリーム上で送信されるため Request ID フィールドはない。
 */
export interface PublishDone {
  type: typeof MessageType.PUBLISH_DONE;
  statusCode: bigint;
  streamCount: bigint;
  reasonPhrase: string;
}

/**
 * Publish のペイロードをエンコード
 *
 * draft-ietf-moq-transport-17 Section 9.11:
 * PUBLISH Message {
 *   Type (i) = 0x1D,
 *   Length (16),
 *   Request ID (i),
 *   Required Request ID Delta (i),
 *   Track Namespace (..),
 *   Track Name Length (i),
 *   Track Name (..),
 *   Track Alias (i),
 *   Number of Parameters (i),
 *   Parameters (..) ...,
 *   Track Properties (..)
 * }
 */
export function encodePublishPayload(msg: Publish): Uint8Array {
  const parts: Uint8Array[] = [];

  parts.push(encodeVarint(msg.requestId));
  parts.push(encodeVarint(msg.requiredRequestIdDelta));
  parts.push(encodeTrackNamespace(msg.trackNamespace));
  parts.push(encodeVarint(msg.trackName.length));
  parts.push(msg.trackName);
  parts.push(encodeVarint(msg.trackAlias));
  parts.push(encodeParameters(msg.parameters));

  // draft-ietf-moq-transport-17 Section 9.11:
  // Track Properties は length プレフィックスなしでシリアライズされる。
  // Message の Length フィールドで終端が決まる。
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
 * Publish のペイロードをデコード
 *
 * リレーサーバー実装用。moqt-js はクライアント専用のため、ランタイムでは使用しない。
 * PBT（Property-Based Testing）でのラウンドトリップテストで使用。
 */
export function decodePublishPayload(data: Uint8Array, offset = 0): Publish {
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

  const [trackAlias, trackAliasConsumed] = decodeVarint(data, offset + totalConsumed);
  totalConsumed += trackAliasConsumed;

  const [parameters, parametersConsumed] = decodeParameters(data, offset + totalConsumed);
  totalConsumed += parametersConsumed;

  // draft-ietf-moq-transport-17 Section 9.11:
  // Track Properties は残りバイトすべて
  const propertiesData = data.slice(offset + totalConsumed);
  const trackProperties = decodeProperties(propertiesData);

  return {
    type: MessageType.PUBLISH,
    requestId,
    requiredRequestIdDelta,
    trackNamespace,
    trackName,
    trackAlias,
    parameters,
    trackProperties,
  };
}

/**
 * PublishOk のペイロードをエンコード
 *
 * リレーサーバー実装用。moqt-js はクライアント専用のため、ランタイムでは使用しない。
 * PBT（Property-Based Testing）でのラウンドトリップテストで使用。
 */
export function encodePublishOkPayload(msg: PublishOk): Uint8Array {
  const parts: Uint8Array[] = [];

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
 * PublishOk のペイロードをデコード
 *
 * draft-ietf-moq-transport-17 Section 9.12:
 * 双方向ストリーム上で送信されるため Request ID は含まない。
 */
export function decodePublishOkPayload(data: Uint8Array, offset = 0): PublishOk {
  let totalConsumed = 0;

  const [parameters, parametersConsumed] = decodeParameters(data, offset + totalConsumed);
  totalConsumed += parametersConsumed;

  return {
    type: MessageType.PUBLISH_OK,
    parameters,
  };
}

/**
 * PublishDone のペイロードをエンコード
 *
 * Session では個別にエンコードしているため、ランタイムでは使用しない。
 * PBT（Property-Based Testing）でのラウンドトリップテストで使用。
 */
export function encodePublishDonePayload(msg: PublishDone): Uint8Array {
  const encoder = new TextEncoder();
  const reasonBytes = encoder.encode(msg.reasonPhrase);

  const parts: Uint8Array[] = [];
  parts.push(encodeVarint(msg.statusCode));
  parts.push(encodeVarint(msg.streamCount));
  parts.push(encodeVarint(reasonBytes.length));
  parts.push(reasonBytes);

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
 * PublishDone のペイロードをデコード
 */
export function decodePublishDonePayload(data: Uint8Array, offset = 0): PublishDone {
  let totalConsumed = 0;

  const [statusCode, statusCodeConsumed] = decodeVarint(data, offset + totalConsumed);
  totalConsumed += statusCodeConsumed;

  const [streamCount, streamCountConsumed] = decodeVarint(data, offset + totalConsumed);
  totalConsumed += streamCountConsumed;

  const [reasonLen, reasonLenConsumed] = decodeVarint(data, offset + totalConsumed);
  totalConsumed += reasonLenConsumed;

  // draft-ietf-moq-transport-17 Section 1.4.4:
  // Reason Phrase の最大長は 1,024 バイト
  if (Number(reasonLen) > MAX_REASON_PHRASE_LENGTH) {
    throw new Error(
      `reason phrase length exceeds maximum: ${reasonLen} > ${MAX_REASON_PHRASE_LENGTH}`,
    );
  }

  const reasonBytes = data.slice(
    offset + totalConsumed,
    offset + totalConsumed + Number(reasonLen),
  );
  const reasonPhrase = new TextDecoder().decode(reasonBytes);

  return {
    type: MessageType.PUBLISH_DONE,
    statusCode,
    streamCount,
    reasonPhrase,
  };
}
