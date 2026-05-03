/**
 * MOQT Track Status Message
 * draft-ietf-moq-transport-17 Section 9.16 (TRACK_STATUS)
 *
 * TRACK_STATUS のメッセージフォーマットは SUBSCRIBE と同一。
 * トラックの状態を問い合わせるために使用し、実際にサブスクライブはしない。
 * 応答は REQUEST_OK（SUBSCRIBE_OK と同じパラメータを含む）。
 *
 * draft-ietf-moq-transport-17:
 * - Subscriber は DELIVERY_TIMEOUT, DEFAULT_PUBLISHER_PRIORITY を送信しない
 *   https://github.com/moq-wg/moq-transport/pull/1325
 * - REQUEST_OK レスポンスに LARGEST_OBJECT パラメータを含めることが可能
 *   https://github.com/moq-wg/moq-transport/pull/1367
 */

import { decodeVarint, encodeVarint } from "../varint";
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
 * TRACK_STATUS メッセージ (Section 9.16 TRACK_STATUS)
 *
 * SUBSCRIBE と同じフォーマットだが、トラックの状態照会用。
 * サブスクリプション状態を作成せず、オブジェクトも送信しない。
 *
 * draft-ietf-moq-transport-17:
 * Subscriber からの TRACK_STATUS には DELIVERY_TIMEOUT, DEFAULT_PUBLISHER_PRIORITY を
 * 含めてはならない（これらは Publisher からの REQUEST_OK レスポンスにのみ含まれる）。
 */
export interface TrackStatus {
  type: typeof MessageType.TRACK_STATUS;
  requestId: bigint;
  // Required Request ID Delta (vi64) - draft-ietf-moq-transport-17 Section 9.2 (Required Request ID)
  // 0 は依存なしを意味する
  requiredRequestIdDelta: bigint;
  trackNamespace: TrackNamespace;
  trackName: Uint8Array;
  parameters: Parameter[];
}

/**
 * TrackStatus のペイロードをエンコード
 *
 * draft-ietf-moq-transport-17 Section 9.16 (TRACK_STATUS):
 * TRACK_STATUS message format is identical to the SUBSCRIBE message.
 */
export function encodeTrackStatusPayload(msg: TrackStatus): Uint8Array {
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
 * TrackStatus のペイロードをデコード
 */
export function decodeTrackStatusPayload(data: Uint8Array, offset = 0): TrackStatus {
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

  const [parameters, parametersConsumed] = decodeParameters(data, offset + totalConsumed);
  totalConsumed += parametersConsumed;

  return {
    type: MessageType.TRACK_STATUS,
    requestId,
    requiredRequestIdDelta,
    trackNamespace,
    trackName,
    parameters,
  };
}
