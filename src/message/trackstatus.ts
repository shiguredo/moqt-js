/**
 * MOQT Track Status Message
 * draft-ietf-moq-transport-21 §9.13 (TRACK_STATUS)
 *
 * TRACK_STATUS のメッセージフォーマットは SUBSCRIBE と同一。
 * トラックの状態を問い合わせるために使用し、実際にサブスクライブはしない。
 *
 * draft-ietf-moq-transport-21 §9.13 (TRACK_STATUS):
 * "The TRACK_STATUS message format is identical to the SUBSCRIBE message
 *  (Section 9.6), but subscriber parameters related to Track delivery
 *  (e.g. SUBSCRIBER_PRIORITY) are not included."
 *
 * 応答は REQUEST_OK であり、§9.3 (REQUEST_OK) の shorthand で TRACK_STATUS_OK と呼ぶ。
 * "This document uses the shorthand PUBLISH_OK, REQUEST_UPDATE_OK, TRACK_STATUS_OK,
 *  SUBSCRIBE_NAMESPACE_OK, SUBSCRIBE_TRACKS_OK and PUBLISH_NAMESPACE_OK to refer to a
 *  REQUEST_OK sent in response to the corresponding request type."
 *
 * draft-ietf-moq-transport-21 §9.13 (TRACK_STATUS):
 * "If successful, the publisher responds with a TRACK_STATUS_OK with the same
 *  parameters and Track Properties it would have set in a SUBSCRIBE_OK."
 * 応答に載りうる LARGEST_OBJECT は §9.20.18 (LARGEST OBJECT Parameter) が
 * "It MAY appear in SUBSCRIBE_OK, PUBLISH, REQUEST_UPDATE_OK, TRACK_STATUS_OK, or
 *  PUBLISH_STATE_NOTIFY." と定める。
 */

import { decodeVarint, encodeVarint } from "../varint";
import { assertLengthWithinData } from "../length";
import { ProtocolViolationError } from "../error";
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
 * TRACK_STATUS メッセージ (Section 9.13 TRACK_STATUS)
 *
 * SUBSCRIBE と同じフォーマットだが、トラックの状態照会用。
 * サブスクリプション状態を作成せず、オブジェクトも送信しない。
 *
 * draft-ietf-moq-transport-21 §9.13 (TRACK_STATUS):
 * "The TRACK_STATUS message format is identical to the SUBSCRIBE message
 *  (Section 9.6), but subscriber parameters related to Track delivery
 *  (e.g. SUBSCRIBER_PRIORITY) are not included."
 * Track delivery に関わる subscriber パラメータを載せない点だけを定めており、
 * 特定のパラメータ名を列挙して禁止しているわけではない。
 */
export interface TrackStatus {
  type: typeof MessageType.TRACK_STATUS;
  requestId: bigint;
  trackNamespace: TrackNamespace;
  trackName: Uint8Array;
  parameters: Parameter[];
}

/**
 * TrackStatus のペイロードをエンコード
 *
 * draft-ietf-moq-transport-21 Section 9.13 (TRACK_STATUS):
 * TRACK_STATUS message format is identical to the SUBSCRIBE message.
 */
export function encodeTrackStatusPayload(msg: TrackStatus): Uint8Array {
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
 * TrackStatus のペイロードをデコード
 */
export function decodeTrackStatusPayload(data: Uint8Array, offset = 0): TrackStatus {
  let totalConsumed = 0;

  const [requestId, requestIdConsumed] = decodeVarint(data, offset + totalConsumed);
  totalConsumed += requestIdConsumed;

  const [trackNamespace, namespaceConsumed] = decodeTrackNamespace(data, offset + totalConsumed);
  totalConsumed += namespaceConsumed;

  const [nameLen, nameLenConsumed] = decodeVarint(data, offset + totalConsumed);
  totalConsumed += nameLenConsumed;
  assertLengthWithinData("track status track name", nameLen, offset + totalConsumed, data.length);
  const trackName = data.slice(offset + totalConsumed, offset + totalConsumed + Number(nameLen));
  totalConsumed += Number(nameLen);

  // draft-ietf-moq-transport-21 §8.7:
  // Full Track Name (Namespace + Track Name 合計) が 4096 バイト超過は PROTOCOL_VIOLATION
  // ワイヤバイト長で計測する (不正 UTF-8 の置換による誤計測を防ぐ)
  validateFullTrackNameBytes(trackNamespace, trackName);

  const [parameters, parametersConsumed] = decodeParameters(data, offset + totalConsumed);
  totalConsumed += parametersConsumed;

  // draft-ietf-moq-transport-21 Section 9:
  // "If the length does not match the length of the Message Body,
  //  the receiver MUST close the session with a PROTOCOL_VIOLATION."
  // Parameters は TRACK_STATUS ペイロードの最後のフィールドであり、
  // その後ろに後続データがあると消費バイト数が Message Body 長と一致しないため違反となる
  if (offset + totalConsumed !== data.length) {
    throw new ProtocolViolationError(
      `trailing data in TRACK_STATUS: expected ${data.length} bytes, consumed ${offset + totalConsumed}`,
    );
  }

  return {
    type: MessageType.TRACK_STATUS,
    requestId,
    trackNamespace,
    trackName,
    parameters,
  };
}
