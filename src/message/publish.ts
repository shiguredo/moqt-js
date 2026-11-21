/**
 * MOQT Publish Messages
 * draft-ietf-moq-transport-23 Section 9.8 (PUBLISH) — 9.3 (REQUEST_OK / PUBLISH_OK) — 9.9 (PUBLISH_DONE)
 *
 * 制御メッセージのフレーミング (Type / Message Length) は
 * draft-ietf-moq-transport-23 §9 に従う。
 */

import { decodeVarint, encodeVarint } from "../varint";
import { ProtocolViolationError, SessionErrorCode } from "../error";
import { type Property, encodeProperties } from "../properties";
import {
  type Parameter,
  type TrackNamespace,
  decodeParametersAndTrackProperties,
  decodeFullTrackName,
  encodeParameters,
  encodeTrackNamespace,
} from "./parameter";
import { MessageType } from "./types";
import { decodeReasonPhrase, encodeReasonPhraseValue } from "./reasonPhrase";

/**
 * PUBLISH メッセージ (Section 9.8 PUBLISH)
 *
 * draft-ietf-moq-transport-23:
 * Track Properties が追加された。
 * draft-ietf-moq-transport-23 Section 9 (Control Messages)
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
 * PUBLISH_DONE メッセージ (Section 9.9 PUBLISH_DONE)
 *
 * draft-ietf-moq-transport-23:
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
 * draft-ietf-moq-transport-23 Section 9.8 (PUBLISH):
 * PUBLISH Message {
 *   Type (vi64) = 0x1D,
 *   Length (vi64),
 *   Request ID (vi64),
 *   Track Namespace (..),
 *   Track Name Length (vi64),
 *   Track Name (..),
 *   Track Alias (vi64),
 *   Number of Parameters (vi64),
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

  // draft-ietf-moq-transport-23 Section 9.8 (PUBLISH):
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
 * draft-ietf-moq-transport-23 Section 9.8 (PUBLISH)
 */
export function decodePublishPayload(data: Uint8Array, offset = 0): Publish {
  let totalConsumed = 0;

  const [requestId, requestIdConsumed] = decodeVarint(data, offset + totalConsumed);
  totalConsumed += requestIdConsumed;

  const [trackNamespace, trackName, nameConsumed] = decodeFullTrackName(
    data,
    offset + totalConsumed,
    "publish",
  );
  totalConsumed += nameConsumed;

  const [trackAlias, trackAliasConsumed] = decodeVarint(data, offset + totalConsumed);
  totalConsumed += trackAliasConsumed;

  const { parameters, trackProperties } = decodeParametersAndTrackProperties(
    data,
    offset + totalConsumed,
    "track",
  );

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
 * PublishDone のペイロードをエンコード
 *
 * Session では個別にエンコードしているため、ランタイムでは使用しない。
 * PBT（Property-Based Testing）でのラウンドトリップテストで使用。
 *
 * draft-ietf-moq-transport-23 Section 9.9 (PUBLISH_DONE):
 * PUBLISH_DONE Message {
 *   Type (vi64) = 0xB,
 *   Length (vi64),
 *   Status Code (vi64),
 *   Stream Count (vi64),
 *   Error Reason (Reason Phrase)
 * }
 */
export function encodePublishDonePayload(msg: PublishDone): Uint8Array {
  const reasonBytes = encodeReasonPhraseValue(msg.reasonPhrase);

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

  const [reasonPhrase, reasonSize] = decodeReasonPhrase(data, offset + totalConsumed);
  totalConsumed += reasonSize;

  // draft-ietf-moq-transport-23 §9:
  // "If the length does not match the length of the Message Body,
  //  the receiver MUST close the session with MALFORMED_MESSAGE."
  // Error Reason は PUBLISH_DONE ペイロードの最後のフィールドであり、
  // その後ろに後続データがあると消費バイト数が Message Body 長と一致しないため違反となる
  if (offset + totalConsumed !== data.length) {
    throw new ProtocolViolationError(
      `trailing data in PUBLISH_DONE: expected ${data.length} bytes, consumed ${offset + totalConsumed}`,
      SessionErrorCode.MALFORMED_MESSAGE,
    );
  }

  return {
    type: MessageType.PUBLISH_DONE,
    statusCode,
    streamCount,
    reasonPhrase,
  };
}
