/**
 * MOQT Session Messages
 * draft-ietf-moq-transport-19 Section 10.4 (GOAWAY) — 10.6 (REQUEST_ERROR)
 */

import { decodeVarint, encodeVarint } from "../varint";
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
import { ProtocolViolationError } from "../error";
import { type Property, decodeProperties, encodeProperties } from "../properties";

/**
 * GOAWAY メッセージ (Section 10.4)
 *
 * draft-ietf-moq-transport-19 Section 10.4 (GOAWAY):
 *
 * GOAWAY Message {
 *   Type (vi64) = 0x10,
 *   Length (16),
 *   New Session URI Length (vi64),
 *   New Session URI (..),
 *   Timeout (vi64),
 * }
 *
 * draft-19 で Request ID フィールドが削除された。
 * 制御ストリームとリクエストストリームでワイヤフォーマットは同一。
 */
export interface Goaway {
  type: typeof MessageType.GOAWAY;
  newSessionUri: string;
  /**
   * Graceful shutdown のタイムアウト（ミリ秒）
   * 0 の場合は即時切断を意味する
   */
  timeout: bigint;
}

/**
 * REQUEST_OK メッセージ (Section 10.5)
 *
 * draft-ietf-moq-transport-19:
 * リクエストへの成功応答。双方向ストリーム上で送信されるため、
 * ストリーム自体がリクエストを特定し、Request ID は不要。
 * draft-ietf-moq-transport-19 Section 10.1
 *
 * REQUEST_OK Message {
 *   Type (vi64) = 0x7,
 *   Length (16),
 *   Number of Parameters (vi64),
 *   Parameters (..),
 *   Track Properties (..),
 * }
 */
export interface RequestOk {
  type: typeof MessageType.REQUEST_OK;
  parameters: Parameter[];
  trackProperties: Property[];
}

/**
 * Redirect Structure (Section 10.6.1)
 *
 * draft-ietf-moq-transport-19 Section 10.6.1 (Redirect Structure):
 *
 * Redirect {
 *   Connect URI Length (vi64),
 *   Connect URI (..),
 *   Track Namespace (..),
 *   Track Name Length (vi64),
 *   Track Name (..),
 * }
 */
export interface Redirect {
  connectUri: string;
  trackNamespace: TrackNamespace;
  trackName: Uint8Array;
}

/**
 * Redirect のペイロードをエンコード
 *
 * draft-ietf-moq-transport-19 Section 10.6.1 (Redirect Structure)
 */
export function encodeRedirect(redirect: Redirect): Uint8Array {
  const uriBytes = new TextEncoder().encode(redirect.connectUri);
  const trackNameLen = redirect.trackName.length;

  const parts: Uint8Array[] = [];
  parts.push(encodeVarint(uriBytes.length));
  parts.push(uriBytes);
  parts.push(encodeTrackNamespace(redirect.trackNamespace));
  parts.push(encodeVarint(trackNameLen));
  parts.push(redirect.trackName);

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
 * Redirect のペイロードをデコード
 *
 * draft-ietf-moq-transport-19 Section 10.6.1 (Redirect Structure)
 *
 * 注: Connect URI に最大長の規定はない (8,192 バイト上限は GOAWAY の
 * New Session URI (§10.4) にのみ存在する)。宣言された URI Length が
 * 実データを超える過剰宣言は、後続フィールドのデコード時に
 * IncompleteDataError として検出される。
 *
 * @returns [redirect, consumed bytes]
 */
export function decodeRedirect(data: Uint8Array, offset: number): [Redirect, number] {
  let totalConsumed = 0;

  const [uriLength, uriLengthSize] = decodeVarint(data, offset + totalConsumed);
  totalConsumed += uriLengthSize;

  const uriBytes = data.slice(offset + totalConsumed, offset + totalConsumed + Number(uriLength));
  const connectUri = new TextDecoder().decode(uriBytes);
  totalConsumed += Number(uriLength);

  const [trackNamespace, namespaceSize] = decodeTrackNamespace(data, offset + totalConsumed);
  totalConsumed += namespaceSize;

  const [trackNameLen, trackNameLenSize] = decodeVarint(data, offset + totalConsumed);
  totalConsumed += trackNameLenSize;

  const trackName = data.slice(
    offset + totalConsumed,
    offset + totalConsumed + Number(trackNameLen),
  );
  totalConsumed += Number(trackNameLen);

  return [{ connectUri, trackNamespace, trackName }, totalConsumed];
}

/**
 * REQUEST_ERROR メッセージ (Section 10.6.2)
 *
 * draft-ietf-moq-transport-19 Section 10.6.2 (REQUEST_ERROR Message Format):
 *
 * REQUEST_ERROR Message {
 *   Type (vi64) = 0x5,
 *   Length (16),
 *   Error Code (vi64),
 *   Retry Interval (vi64),
 *   Error Reason (Reason Phrase),
 *   [Redirect (Redirect),]
 * }
 *
 * - Redirect: Present only when Error Code is REDIRECT. See Section 10.6.1.
 *
 * Retry Interval: 再試行までに待つべきミリ秒 + 1
 * - 0: 再試行すべきではない
 * - 1 以上: 再試行可能（1 は即座の再試行を許可）
 */
export interface RequestError {
  type: typeof MessageType.REQUEST_ERROR;
  errorCode: bigint;
  retryInterval: bigint;
  reasonPhrase: string;
  redirect?: Redirect;
}

/**
 * Goaway のペイロードをエンコード
 *
 * draft-ietf-moq-transport-19 Section 10.4:
 * New Session URI Length + New Session URI + Timeout
 */
export function encodeGoawayPayload(msg: Goaway): Uint8Array {
  const uriBytes = new TextEncoder().encode(msg.newSessionUri);
  const parts: Uint8Array[] = [];

  parts.push(encodeVarint(uriBytes.length));
  parts.push(uriBytes);
  parts.push(encodeVarint(msg.timeout));

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
 * Goaway のペイロードをデコード
 *
 * draft-ietf-moq-transport-19 Section 10.4:
 * New Session URI Length + New Session URI + Timeout
 * Timeout 消費後に余剰バイトがあれば PROTOCOL_VIOLATION
 */
export function decodeGoawayPayload(data: Uint8Array, offset = 0): Goaway {
  const [uriLength, uriLengthSize] = decodeVarint(data, offset);
  offset += uriLengthSize;

  // draft-ietf-moq-transport-19 Section 10.4:
  // "The maximum length of the New Session URI is 8,192 bytes.
  //  If an endpoint receives a length exceeding the maximum,
  //  it MUST close the session with a PROTOCOL_VIOLATION."
  if (Number(uriLength) > 8192) {
    throw new ProtocolViolationError(`GOAWAY URI length exceeds maximum: ${uriLength} > 8192`);
  }

  const uriBytes = data.slice(offset, offset + Number(uriLength));
  const newSessionUri = new TextDecoder().decode(uriBytes);
  offset += Number(uriLength);

  const [timeout, timeoutSize] = decodeVarint(data, offset);
  offset += timeoutSize;

  // draft-ietf-moq-transport-19 Section 10:
  // "If the length does not match the length of the Message Body,
  //  the receiver MUST close the session with a PROTOCOL_VIOLATION."
  // Timeout は GOAWAY ペイロードの最後のフィールドであり、
  // その後ろに後続データがあると消費バイト数が Message Body 長と一致しないため違反となる
  if (offset !== data.length) {
    throw new ProtocolViolationError(
      `trailing data after Timeout in GOAWAY: expected ${data.length} bytes, consumed ${offset}`,
    );
  }

  return {
    type: MessageType.GOAWAY,
    newSessionUri,
    timeout,
  };
}

/**
 * RequestOk のペイロードをエンコード
 *
 * draft-ietf-moq-transport-19 Section 10.5:
 * Number of Parameters + Parameters
 * draft-ietf-moq-transport-19 Section 10.1
 *
 * リレーサーバー実装用。moqt-js はクライアント専用のため、ランタイムでは使用しない。
 * PBT（Property-Based Testing）でのラウンドトリップテストで使用。
 */
export function encodeRequestOkPayload(msg: RequestOk): Uint8Array {
  const parts: Uint8Array[] = [];

  parts.push(encodeParameters(msg.parameters));
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
 * RequestOk のペイロードをデコード
 *
 * draft-ietf-moq-transport-19 Section 10.5:
 * Number of Parameters + Parameters + Track Properties
 * - Track Properties は残りバイトすべて
 */
export function decodeRequestOkPayload(data: Uint8Array, offset = 0): RequestOk {
  const [parameters, paramsConsumed] = decodeParameters(data, offset);
  offset += paramsConsumed;

  const propertiesData = data.slice(offset);
  const trackProperties = decodeProperties(propertiesData);

  return {
    type: MessageType.REQUEST_OK,
    parameters,
    trackProperties,
  };
}

/**
 * RequestError のペイロードをエンコード
 *
 * draft-ietf-moq-transport-19 Section 10.6.2:
 * Error Code + Retry Interval + Error Reason + [Redirect]
 *
 * - Redirect は msg.redirect が存在する場合のみエンコードする
 *
 * リレーサーバー実装用。moqt-js はクライアント専用のため、ランタイムでは使用しない。
 * PBT（Property-Based Testing）でのラウンドトリップテストで使用。
 */
export function encodeRequestErrorPayload(msg: RequestError): Uint8Array {
  const encoder = new TextEncoder();
  const reasonBytes = encoder.encode(msg.reasonPhrase);

  const parts: Uint8Array[] = [];
  parts.push(encodeVarint(msg.errorCode));
  parts.push(encodeVarint(msg.retryInterval));
  parts.push(encodeVarint(reasonBytes.length));
  parts.push(reasonBytes);

  if (msg.redirect) {
    parts.push(encodeRedirect(msg.redirect));
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
 * RequestError のペイロードをデコード
 *
 * draft-ietf-moq-transport-19 Section 10.6.2:
 * Error Code + Retry Interval + Error Reason + [Redirect]
 *
 * - Error Reason の後、残りバイトがあれば Redirect をデコードする
 * - Error Code が REDIRECT (0x34) 以外で Redirect が存在する場合: ProtocolViolationError
 */
export function decodeRequestErrorPayload(data: Uint8Array, offset = 0): RequestError {
  const [errorCode, errorCodeSize] = decodeVarint(data, offset);
  offset += errorCodeSize;

  const [retryInterval, retryIntervalSize] = decodeVarint(data, offset);
  offset += retryIntervalSize;

  const [reasonLen, reasonLenSize] = decodeVarint(data, offset);
  offset += reasonLenSize;

  // draft-ietf-moq-transport-19 Section 1.4.4:
  // Reason Phrase の最大長は 1,024 バイト。
  // "If an endpoint receives a length exceeding the maximum, it MUST close
  //  the session with a PROTOCOL_VIOLATION"
  if (Number(reasonLen) > MAX_REASON_PHRASE_LENGTH) {
    throw new ProtocolViolationError(
      `reason phrase length exceeds maximum: ${reasonLen} > ${MAX_REASON_PHRASE_LENGTH}`,
    );
  }

  const decoder = new TextDecoder();
  const reasonPhrase = decoder.decode(data.slice(offset, offset + Number(reasonLen)));
  offset += Number(reasonLen);

  let redirect: Redirect | undefined;
  if (offset < data.length) {
    // draft-ietf-moq-transport-19 Section 10.6.2:
    // "Redirect: Present only when Error Code is REDIRECT."
    // それ以外のエラーコードで Redirect が存在する場合はプロトコル違反
    if (Number(errorCode) !== 0x34) {
      throw new ProtocolViolationError(
        `unexpected redirect in REQUEST_ERROR with error code 0x${Number(errorCode).toString(16)}, expected REDIRECT (0x34)`,
      );
    }
    const [decodedRedirect, redirectSize] = decodeRedirect(data, offset);
    redirect = decodedRedirect;
    offset += redirectSize;
    // draft-ietf-moq-transport-19 Section 10:
    // "If the length does not match the length of the Message Body,
    //  the receiver MUST close the session with a PROTOCOL_VIOLATION."
    // Redirect は REQUEST_ERROR ペイロードの最後のフィールド (Section 10.6.2) であり、
    // その後ろに後続データがあると消費バイト数が Message Body 長と一致しないため違反となる
    if (offset !== data.length) {
      throw new ProtocolViolationError(
        `trailing data after Redirect in REQUEST_ERROR: expected ${data.length} bytes, consumed ${offset}`,
      );
    }
  }

  return {
    type: MessageType.REQUEST_ERROR,
    errorCode,
    retryInterval,
    reasonPhrase,
    redirect,
  };
}
