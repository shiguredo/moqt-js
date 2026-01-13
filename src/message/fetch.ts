/**
 * MOQT Fetch Messages
 * draft-ietf-moq-transport-16 Section 9.16-9.18
 */

import { decodeVarint, encodeVarint } from "../varint";
import {
  type ExtensionHeader,
  decodeExtensionHeaders,
  encodeExtensionHeaders,
} from "../extensions";
import {
  type Parameter,
  type TrackNamespace,
  decodeLocation,
  decodeParameter,
  decodeTrackNamespace,
  encodeLocation,
  encodeParameter,
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
export interface FetchOk {
  type: typeof MessageType.FETCH_OK;
  requestId: bigint;
  endOfTrack: boolean;
  endLocation: Location;
  parameters: Parameter[];
  trackExtensions: ExtensionHeader[];
}

/**
 * FETCH_CANCEL メッセージ (Section 9.18)
 */
export interface FetchCancel {
  type: typeof MessageType.FETCH_CANCEL;
  requestId: bigint;
}

/**
 * Fetch のペイロードをエンコード
 */
export function encodeFetchPayload(msg: Fetch): Uint8Array {
  const parts: Uint8Array[] = [];

  parts.push(encodeVarint(msg.requestId));
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
 * Fetch のペイロードをデコード
 *
 * リレーサーバー実装用。moqt-js はクライアント専用のため、ランタイムでは使用しない。
 * PBT（Property-Based Testing）でのラウンドトリップテストで使用。
 */
export function decodeFetchPayload(data: Uint8Array, offset = 0): Fetch {
  let totalConsumed = 0;

  const [requestId, requestIdSize] = decodeVarint(data, offset + totalConsumed);
  totalConsumed += requestIdSize;

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

  const [numParams, numParamsSize] = decodeVarint(data, offset + totalConsumed);
  totalConsumed += numParamsSize;

  const parameters: Parameter[] = [];
  for (let i = 0; i < numParams; i++) {
    const [param, paramSize] = decodeParameter(data, offset + totalConsumed);
    parameters.push(param);
    totalConsumed += paramSize;
  }

  return {
    type: MessageType.FETCH,
    requestId,
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
 * draft-ietf-moq-transport-16 Section 9.17:
 * FETCH_OK Message {
 *   Type (i) = 0x5,
 *   Length (16),
 *   Request ID (i),
 *   End of Track (1),
 *   End Group (i),
 *   End Object (i),
 *   Number of Parameters (i),
 *   Parameters (..) ...,
 *   Track Extensions Length (i),
 *   Track Extensions (..)
 * }
 */
export function encodeFetchOkPayload(msg: FetchOk): Uint8Array {
  const parts: Uint8Array[] = [];

  parts.push(encodeVarint(msg.requestId));
  parts.push(new Uint8Array([msg.endOfTrack ? 1 : 0]));
  parts.push(encodeLocation(msg.endLocation));
  parts.push(encodeVarint(msg.parameters.length));
  for (const param of msg.parameters) {
    parts.push(encodeParameter(param));
  }

  // Track Extensions
  const extensionsData = encodeExtensionHeaders(msg.trackExtensions);
  parts.push(encodeVarint(extensionsData.length));
  parts.push(extensionsData);

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

  const [requestId, requestIdSize] = decodeVarint(data, offset + totalConsumed);
  totalConsumed += requestIdSize;

  const endOfTrack = data[offset + totalConsumed] === 1;
  totalConsumed += 1;

  const [endLocation, endLocationSize] = decodeLocation(data, offset + totalConsumed);
  totalConsumed += endLocationSize;

  const [numParams, numParamsSize] = decodeVarint(data, offset + totalConsumed);
  totalConsumed += numParamsSize;

  const parameters: Parameter[] = [];
  for (let i = 0; i < numParams; i++) {
    const [param, paramSize] = decodeParameter(data, offset + totalConsumed);
    parameters.push(param);
    totalConsumed += paramSize;
  }

  // Track Extensions
  const [extensionsLen, extensionsLenSize] = decodeVarint(data, offset + totalConsumed);
  totalConsumed += extensionsLenSize;

  const extensionsData = data.slice(
    offset + totalConsumed,
    offset + totalConsumed + Number(extensionsLen),
  );
  const trackExtensions = decodeExtensionHeaders(extensionsData);

  return {
    type: MessageType.FETCH_OK,
    requestId,
    endOfTrack,
    endLocation,
    parameters,
    trackExtensions,
  };
}

/**
 * FetchCancel のペイロードをエンコード
 */
export function encodeFetchCancelPayload(msg: FetchCancel): Uint8Array {
  return encodeVarint(msg.requestId);
}

/**
 * FetchCancel のペイロードをデコード
 *
 * リレーサーバー実装用。moqt-js はクライアント専用のため、ランタイムでは使用しない。
 * PBT（Property-Based Testing）でのラウンドトリップテストで使用。
 */
export function decodeFetchCancelPayload(data: Uint8Array, offset = 0): FetchCancel {
  const [requestId] = decodeVarint(data, offset);
  return {
    type: MessageType.FETCH_CANCEL,
    requestId,
  };
}
