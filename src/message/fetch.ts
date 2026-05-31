/**
 * MOQT Fetch Messages
 * draft-ietf-moq-transport-18 Section 10.12 (FETCH) — 10.13 (FETCH_OK)
 */

import { decodeVarint, encodeVarint } from "../varint";
import { ProtocolViolationError } from "../error";
import { type Property, decodeProperties, encodeProperties } from "../properties";
import {
  type Parameter,
  type TrackNamespace,
  decodeLocation,
  decodeParameters,
  decodeTrackNamespace,
  encodeLocation,
  encodeParameters,
  encodeTrackNamespace,
} from "./parameter";
import { type Location, MessageType } from "./types";

/**
 * Fetch Type (Section 10.12 FETCH)
 */
export const FetchType = {
  STANDALONE: 0x01,
  RELATIVE_JOINING: 0x02,
  ABSOLUTE_JOINING: 0x03,
} as const;

export type FetchType = (typeof FetchType)[keyof typeof FetchType];

/**
 * Standalone Fetch structure (Section 10.12.1 Standalone Fetch)
 */
export interface StandaloneFetch {
  trackNamespace: TrackNamespace;
  trackName: Uint8Array;
  startLocation: Location;
  endLocation: Location;
}

/**
 * Joining Fetch structure (Section 10.12.2 Joining Fetches)
 */
export interface JoiningFetch {
  joiningRequestId: bigint;
  joiningStart: bigint;
}

/**
 * FETCH メッセージ (Section 10.12 FETCH)
 */
export interface Fetch {
  type: typeof MessageType.FETCH;
  requestId: bigint;
  // 0 は依存なしを意味する
  requiredRequestIdDelta: bigint;
  fetchType: FetchType;
  standalone?: StandaloneFetch;
  joining?: JoiningFetch;
  parameters: Parameter[];
}

/**
 * FETCH_OK メッセージ (Section 10.13 FETCH_OK)
 *
 * draft-ietf-moq-transport-18:
 * - 双方向ストリーム上で送信されるため Request ID は不要。
 * - Track Properties が追加された。
 * draft-ietf-moq-transport-18 Section 10 (Control Messages)
 */
export interface FetchOk {
  type: typeof MessageType.FETCH_OK;
  endOfTrack: boolean;
  endLocation: Location;
  parameters: Parameter[];
  trackProperties: Property[];
}

/**
 * Fetch のペイロードをエンコード
 */
export function encodeFetchPayload(msg: Fetch): Uint8Array {
  const parts: Uint8Array[] = [];

  parts.push(encodeVarint(msg.requestId));
  parts.push(encodeVarint(msg.requiredRequestIdDelta));
  parts.push(encodeVarint(msg.fetchType));

  if (msg.fetchType === FetchType.STANDALONE && msg.standalone) {
    parts.push(encodeTrackNamespace(msg.standalone.trackNamespace));
    parts.push(encodeVarint(msg.standalone.trackName.length));
    parts.push(msg.standalone.trackName);
    parts.push(encodeLocation(msg.standalone.startLocation));
    parts.push(encodeLocation(msg.standalone.endLocation));
  } else if (msg.joining) {
    parts.push(encodeVarint(msg.joining.joiningRequestId));
    parts.push(encodeVarint(msg.joining.joiningStart));
  }

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
 * Fetch のペイロードをデコード
 *
 * リレーサーバー実装用。moqt-js はクライアント専用のため、ランタイムでは使用しない。
 * PBT（Property-Based Testing）でのラウンドトリップテストで使用。
 */
export function decodeFetchPayload(data: Uint8Array, offset = 0): Fetch {
  let totalConsumed = 0;

  const [requestId, requestIdSize] = decodeVarint(data, offset + totalConsumed);
  totalConsumed += requestIdSize;

  const [requiredRequestIdDelta, requiredRequestIdDeltaSize] = decodeVarint(
    data,
    offset + totalConsumed,
  );
  totalConsumed += requiredRequestIdDeltaSize;

  const [fetchType, fetchTypeSize] = decodeVarint(data, offset + totalConsumed);
  totalConsumed += fetchTypeSize;

  let standalone: StandaloneFetch | undefined;
  let joining: JoiningFetch | undefined;

  // draft-ietf-moq-transport-18 Section 10.12 (FETCH):
  // "An endpoint that receives a Fetch Type other than 0x1, 0x2 or 0x3 MUST close
  //  the session with a PROTOCOL_VIOLATION."
  const fetchTypeValue = Number(fetchType);
  switch (fetchTypeValue) {
    case FetchType.STANDALONE: {
      const [trackNamespace, namespaceSize] = decodeTrackNamespace(data, offset + totalConsumed);
      totalConsumed += namespaceSize;

      const [trackNameLen, trackNameLenSize] = decodeVarint(data, offset + totalConsumed);
      totalConsumed += trackNameLenSize;

      const trackName = data.slice(
        offset + totalConsumed,
        offset + totalConsumed + Number(trackNameLen),
      );
      totalConsumed += Number(trackNameLen);

      const [startLocation, startLocationSize] = decodeLocation(data, offset + totalConsumed);
      totalConsumed += startLocationSize;

      const [endLocation, endLocationSize] = decodeLocation(data, offset + totalConsumed);
      totalConsumed += endLocationSize;

      standalone = {
        trackNamespace,
        trackName,
        startLocation,
        endLocation,
      };
      break;
    }
    case FetchType.RELATIVE_JOINING:
    case FetchType.ABSOLUTE_JOINING: {
      const [joiningRequestId, joiningRequestIdSize] = decodeVarint(data, offset + totalConsumed);
      totalConsumed += joiningRequestIdSize;

      const [joiningStart, joiningStartSize] = decodeVarint(data, offset + totalConsumed);
      totalConsumed += joiningStartSize;

      joining = {
        joiningRequestId,
        joiningStart,
      };
      break;
    }
    default:
      throw new ProtocolViolationError(
        `unknown fetch type: 0x${fetchTypeValue.toString(16)}, expected 0x1, 0x2, or 0x3`,
      );
  }

  const [parameters, parametersConsumed] = decodeParameters(data, offset + totalConsumed);
  totalConsumed += parametersConsumed;

  return {
    type: MessageType.FETCH,
    requestId,
    requiredRequestIdDelta,
    fetchType: Number(fetchType) as FetchType,
    standalone,
    joining,
    parameters,
  };
}

/**
 * FetchOk のペイロードをエンコード
 *
 * リレーサーバー実装用。moqt-js はクライアント専用のため、ランタイムでは使用しない。
 * PBT（Property-Based Testing）でのラウンドトリップテストで使用。
 *
 * draft-ietf-moq-transport-18 Section 10.13 (FETCH_OK):
 * FETCH_OK Message {
 *   Type (i) = 0x18,
 *   Length (16),
 *   End of Track (8),
 *   End Location (Location),
 *   Number of Parameters (i),
 *   Parameters (..) ...,
 *   Track Properties (..)
 * }
 */
export function encodeFetchOkPayload(msg: FetchOk): Uint8Array {
  const parts: Uint8Array[] = [];

  parts.push(new Uint8Array([msg.endOfTrack ? 1 : 0]));
  parts.push(encodeLocation(msg.endLocation));
  parts.push(encodeParameters(msg.parameters));

  // draft-ietf-moq-transport-18 Section 10.13 (FETCH_OK):
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
 * FetchOk のペイロードをデコード
 */
export function decodeFetchOkPayload(data: Uint8Array, offset = 0): FetchOk {
  let totalConsumed = 0;

  const endOfTrack = data[offset + totalConsumed] === 1;
  totalConsumed += 1;

  const [endLocation, endLocationSize] = decodeLocation(data, offset + totalConsumed);
  totalConsumed += endLocationSize;

  const [parameters, parametersConsumed] = decodeParameters(data, offset + totalConsumed);
  totalConsumed += parametersConsumed;

  // draft-ietf-moq-transport-18 Section 10.13 (FETCH_OK):
  // Track Properties は残りバイトすべて
  const propertiesData = data.slice(offset + totalConsumed);
  const trackProperties = decodeProperties(propertiesData);

  return {
    type: MessageType.FETCH_OK,
    endOfTrack,
    endLocation,
    parameters,
    trackProperties,
  };
}
