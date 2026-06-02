/**
 * MOQT Publish Messages
 * draft-ietf-moq-transport-18 Section 10.10 (PUBLISH) — 10.5 (REQUEST_OK / PUBLISH_OK) — 10.11 (PUBLISH_DONE)
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
 * PUBLISH メッセージ (Section 10.10 PUBLISH)
 *
 * draft-ietf-moq-transport-18:
 * Track Properties が追加された。
 * draft-ietf-moq-transport-18 Section 10 (Control Messages)
 */
export interface Publish {
  type: typeof MessageType.PUBLISH;
  requestId: bigint;
  trackNamespace: TrackNamespace;
  trackName: Uint8Array;
  trackAlias: bigint;
  parameters: Parameter[];
  trackProperties: Property[];
}

/**
 * PublishOk: PUBLISH への成功応答 (REQUEST_OK with PUBLISH_OK semantics)
 *
 * draft-ietf-moq-transport-18 §10.5:
 * Wire format 上は REQUEST_OK (0x7) のみが存在し、
 * PUBLISH_OK は REQUEST_OK の textual alias。
 */
export interface PublishOk {
  type: typeof MessageType.REQUEST_OK;
  parameters: Parameter[];
}

/**
 * PUBLISH_DONE メッセージ (Section 10.11 PUBLISH_DONE)
 *
 * draft-ietf-moq-transport-18:
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
 * draft-ietf-moq-transport-18 Section 10.10 (PUBLISH):
 * PUBLISH Message {
 *   Type (i) = 0x1D,
 *   Length (16),
 *   Request ID (i),
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
  parts.push(encodeTrackNamespace(msg.trackNamespace));
  parts.push(encodeVarint(msg.trackName.length));
  parts.push(msg.trackName);
  parts.push(encodeVarint(msg.trackAlias));
  parts.push(encodeParameters(msg.parameters));

  // draft-ietf-moq-transport-18 Section 10.10 (PUBLISH):
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

  // draft-ietf-moq-transport-18 Section 10.10 (PUBLISH):
  // Track Properties は残りバイトすべて
  const propertiesData = data.slice(offset + totalConsumed);
  const trackProperties = decodeProperties(propertiesData);

  return {
    type: MessageType.PUBLISH,
    requestId,
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
 * draft-ietf-moq-transport-18 Section 10.5 (REQUEST_OK):
 * 双方向ストリーム上で送信されるため Request ID は含まない。
 */
export function decodePublishOkPayload(data: Uint8Array, offset = 0): PublishOk {
  let totalConsumed = 0;

  const [parameters, parametersConsumed] = decodeParameters(data, offset + totalConsumed);
  totalConsumed += parametersConsumed;

  return {
    type: MessageType.REQUEST_OK,
    parameters,
  };
}

/**
 * PublishDone のペイロードをエンコード
 *
 * Session では個別にエンコードしているため、ランタイムでは使用しない。
 * PBT（Property-Based Testing）でのラウンドトリップテストで使用。
 *
 * draft-ietf-moq-transport-18 Section 10.11 (PUBLISH_DONE):
 * PUBLISH_DONE Message {
 *   Type (vi64) = 0xB,
 *   Length (16),
 *   Status Code (vi64),
 *   Stream Count (vi64),
 *   Error Reason (Reason Phrase)
 * }
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

  // draft-ietf-moq-transport-18 Section 1.4.4:
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
