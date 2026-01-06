/**
 * MOQT Track Status Message
 * draft-ietf-moq-transport-15 Section 9.19
 *
 * TRACK_STATUS のメッセージフォーマットは SUBSCRIBE と同一。
 * トラックの状態を問い合わせるために使用し、実際にサブスクライブはしない。
 * 応答は REQUEST_OK（SUBSCRIBE_OK と同じパラメータを含む）。
 */

import { decodeVarint, encodeVarint } from "../varint";
import {
  type Parameter,
  type TrackNamespace,
  decodeParameter,
  decodeTrackNamespace,
  encodeParameter,
  encodeTrackNamespace,
} from "./parameter";
import { MessageType } from "./types";

/**
 * TRACK_STATUS メッセージ (Section 9.19)
 *
 * SUBSCRIBE と同じフォーマットだが、トラックの状態照会用。
 * サブスクリプション状態を作成せず、オブジェクトも送信しない。
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
 * draft-ietf-moq-transport-15 Section 9.19:
 * TRACK_STATUS message format is identical to the SUBSCRIBE message.
 */
export function encodeTrackStatusPayload(msg: TrackStatus): Uint8Array {
  const parts: Uint8Array[] = [];

  parts.push(encodeVarint(msg.requestId));
  parts.push(encodeTrackNamespace(msg.trackNamespace));
  parts.push(encodeVarint(msg.trackName.length));
  parts.push(msg.trackName);
  parts.push(encodeVarint(msg.parameters.length));
  for (const param of msg.parameters) {
    parts.push(encodeParameter(param));
  }

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
  const trackName = data.slice(offset + totalConsumed, offset + totalConsumed + Number(nameLen));
  totalConsumed += Number(nameLen);

  const [numParams, numParamsConsumed] = decodeVarint(data, offset + totalConsumed);
  totalConsumed += numParamsConsumed;

  const parameters: Parameter[] = [];
  for (let i = 0; i < Number(numParams); i++) {
    const [param, paramConsumed] = decodeParameter(data, offset + totalConsumed);
    parameters.push(param);
    totalConsumed += paramConsumed;
  }

  return {
    type: MessageType.TRACK_STATUS,
    requestId,
    trackNamespace,
    trackName,
    parameters,
  };
}
