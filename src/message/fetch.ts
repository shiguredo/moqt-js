/**
 * MOQT Fetch Messages
 * draft-ietf-moq-transport-20 Section 10.13 (FETCH) — 10.14 (FETCH_OK)
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
  validateFullTrackNameBytes,
} from "./parameter";
import { type Location, MessageType } from "./types";

/**
 * FETCH メッセージ (Section 10.13 FETCH)
 *
 * draft-ietf-moq-transport-20:
 * FETCH Message {
 *   Type (vi64) = 0x16,
 *   Length (16),
 *   Request ID (vi64),
 *   Track Namespace (..),
 *   Track Name Length (vi64),
 *   Track Name (..),
 *   Number of Parameters (vi64),
 *   Parameters (..) ...
 * }
 *
 * 取得する範囲は LOCATION_FILTER パラメータ (0x21) で指定する (§10.2.9)。
 * パラメータを省略した場合、フィルタなしとして {0, 0} から Largest Object
 * までの全オブジェクトを要求する (§5.1.2)。
 */
export interface Fetch {
  type: typeof MessageType.FETCH;
  requestId: bigint;
  trackNamespace: TrackNamespace;
  trackName: Uint8Array;
  parameters: Parameter[];
}

/**
 * FETCH_OK メッセージ (Section 10.14 FETCH_OK)
 *
 * draft-ietf-moq-transport-20:
 * - 双方向ストリーム上で送信されるため Request ID は不要。
 * - Track Properties が追加された。
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
 *
 * draft-ietf-moq-transport-20 Section 10.13 (FETCH):
 * FETCH は Track Namespace / Track Name + Parameters のみを持つ
 * (draft-19 の Fetch Type / Start / End Location フィールドは削除された)。
 */
export function encodeFetchPayload(msg: Fetch): Uint8Array {
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
 * Fetch のペイロードをデコード
 *
 * リレーサーバー実装用。moqt-js はクライアント専用のため、ランタイムでは使用しない。
 * PBT（Property-Based Testing）でのラウンドトリップテストで使用。
 */
export function decodeFetchPayload(data: Uint8Array, offset = 0): Fetch {
  let totalConsumed = 0;

  const [requestId, requestIdSize] = decodeVarint(data, offset + totalConsumed);
  totalConsumed += requestIdSize;

  const [trackNamespace, namespaceSize] = decodeTrackNamespace(data, offset + totalConsumed);
  totalConsumed += namespaceSize;

  const [trackNameLen, trackNameLenSize] = decodeVarint(data, offset + totalConsumed);
  totalConsumed += trackNameLenSize;

  const trackName = data.slice(
    offset + totalConsumed,
    offset + totalConsumed + Number(trackNameLen),
  );
  totalConsumed += Number(trackNameLen);

  // draft-ietf-moq-transport-20 §2.4.1:
  // Full Track Name (Namespace + Track Name 合計) が 4096 バイト超過は
  // PROTOCOL_VIOLATION。ワイヤバイト長で計測する (不正 UTF-8 の置換による
  // 誤計測を防ぐ)
  validateFullTrackNameBytes(trackNamespace, trackName);

  const [parameters, parametersConsumed] = decodeParameters(data, offset + totalConsumed);
  totalConsumed += parametersConsumed;

  // draft-ietf-moq-transport-20 Section 10:
  // "If the length does not match the length of the Message Body,
  //  the receiver MUST close the session with a PROTOCOL_VIOLATION."
  // Parameters は FETCH ペイロードの最後のフィールドであり、
  // その後ろに後続データがあると消費バイト数が Message Body 長と一致しないため違反となる
  if (offset + totalConsumed !== data.length) {
    throw new ProtocolViolationError(
      `trailing data in FETCH: expected ${data.length} bytes, consumed ${offset + totalConsumed}`,
    );
  }

  return {
    type: MessageType.FETCH,
    requestId,
    trackNamespace,
    trackName,
    parameters,
  };
}

/**
 * FetchOk のペイロードをエンコード
 *
 * リレーサーバー実装用。moqt-js はクライアント専用のため、ランタイムでは使用しない。
 * PBT（Property-Based Testing）でのラウンドトリップテストで使用。
 *
 * draft-ietf-moq-transport-20 Section 10.14 (FETCH_OK):
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

  // draft-ietf-moq-transport-20 Section 10.14 (FETCH_OK):
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

  // draft-ietf-moq-transport-20 Section 10.14 (FETCH_OK):
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
