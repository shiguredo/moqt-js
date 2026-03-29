/**
 * MOQT Fetch Messages
 * draft-ietf-moq-transport-17 Section 9.16-9.17
 */

import { decodeVarint, encodeVarint } from "../varint";
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
 * Fetch Type (Section 9.16)
 */
export const FetchType = {
  STANDALONE: 0x01,
  RELATIVE_JOINING: 0x02,
  ABSOLUTE_JOINING: 0x03,
} as const;

export type FetchType = (typeof FetchType)[keyof typeof FetchType];

/**
 * Standalone Fetch structure (Section 9.16.1)
 */
export interface StandaloneFetch {
  trackNamespace: TrackNamespace;
  trackName: Uint8Array;
  startLocation: Location;
  endLocation: Location;
}

/**
 * Joining Fetch structure (Section 9.16.2)
 */
export interface JoiningFetch {
  joiningRequestId: bigint;
  joiningStart: bigint;
}

/**
 * FETCH メッセージ (Section 9.16)
 */
export interface Fetch {
  type: typeof MessageType.FETCH;
  requestId: bigint;
  // Required Request ID Delta (vi64) - draft-ietf-moq-transport-17 Section 9.2
  // 0 は依存なしを意味する
  requiredRequestIdDelta: bigint;
  fetchType: FetchType;
  standalone?: StandaloneFetch;
  joining?: JoiningFetch;
  parameters: Parameter[];
}

/**
 * FETCH_OK メッセージ (Section 9.17)
 *
 * draft-ietf-moq-transport-16:
 * Track Extensions が追加された。
 * https://github.com/moq-wg/moq-transport/pull/1374
 */
/**
 * draft-ietf-moq-transport-17 Section 9.15:
 * 双方向ストリーム上で送信されるため Request ID は不要。
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

  if (Number(fetchType) === FetchType.STANDALONE) {
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
  } else {
    const [joiningRequestId, joiningRequestIdSize] = decodeVarint(data, offset + totalConsumed);
    totalConsumed += joiningRequestIdSize;

    const [joiningStart, joiningStartSize] = decodeVarint(data, offset + totalConsumed);
    totalConsumed += joiningStartSize;

    joining = {
      joiningRequestId,
      joiningStart,
    };
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
 * draft-ietf-moq-transport-17 Section 9.15:
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

  // draft-ietf-moq-transport-17 Section 9.15:
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

  // draft-ietf-moq-transport-17 Section 9.15:
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
