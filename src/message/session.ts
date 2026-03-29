/**
 * MOQT Session Messages
 * draft-ietf-moq-transport-17 Section 9.5-9.7
 */

import { decodeVarint, encodeVarint } from "../varint";
import {
  MAX_REASON_PHRASE_LENGTH,
  type Parameter,
  decodeParameters,
  encodeParameters,
} from "./parameter";
import { MessageType } from "./types";

/**
 * GOAWAY メッセージ (Section 9.5)
 *
 * draft-ietf-moq-transport-17:
 * セッションを終了する意図を通知する。
 * サーバーはセッションマイグレーション用のオプショナル URI を含めることができる。
 * Timeout フィールドが追加された。
 * https://github.com/moq-wg/moq-transport/pull/1497
 *
 * GOAWAY Message {
 *   Type (vi64) = 0x10,
 *   Length (16),
 *   New Session URI Length (vi64),
 *   New Session URI (..),
 *   Timeout (vi64),
 * }
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
 * REQUEST_OK メッセージ (Section 9.6)
 *
 * draft-ietf-moq-transport-17:
 * リクエストへの成功応答。双方向ストリーム上で送信されるため、
 * ストリーム自体がリクエストを特定し、Request ID は不要。
 * https://github.com/moq-wg/moq-transport/pull/1499
 *
 * REQUEST_OK Message {
 *   Type (vi64) = 0x7,
 *   Length (16),
 *   Number of Parameters (vi64),
 *   Parameters (..),
 * }
 */
export interface RequestOk {
  type: typeof MessageType.REQUEST_OK;
  parameters: Parameter[];
}

/**
 * REQUEST_ERROR メッセージ (Section 9.7)
 *
 * draft-ietf-moq-transport-17:
 * リクエストへの失敗応答。双方向ストリーム上で送信されるため、
 * ストリーム自体がリクエストを特定し、Request ID は不要。
 * https://github.com/moq-wg/moq-transport/pull/1499
 *
 * REQUEST_ERROR Message {
 *   Type (vi64) = 0x5,
 *   Length (16),
 *   Error Code (vi64),
 *   Retry Interval (vi64),
 *   Error Reason (Reason Phrase),
 * }
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
}

/**
 * Goaway のペイロードをエンコード
 *
 * draft-ietf-moq-transport-17 Section 9.5:
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
 */
export function decodeGoawayPayload(data: Uint8Array, offset = 0): Goaway {
  const [uriLength, uriLengthSize] = decodeVarint(data, offset);
  offset += uriLengthSize;

  // draft-ietf-moq-transport-17 Section 9.5:
  // "The maximum length of the New Session URI is 8,192 bytes.
  //  If an endpoint receives a length exceeding the maximum,
  //  it MUST close the session with a PROTOCOL_VIOLATION."
  if (Number(uriLength) > 8192) {
    throw new Error(`GOAWAY URI length exceeds maximum: ${uriLength} > 8192`);
  }

  const uriBytes = data.slice(offset, offset + Number(uriLength));
  const newSessionUri = new TextDecoder().decode(uriBytes);
  offset += Number(uriLength);

  const [timeout] = decodeVarint(data, offset);

  return {
    type: MessageType.GOAWAY,
    newSessionUri,
    timeout,
  };
}

/**
 * RequestOk のペイロードをエンコード
 *
 * draft-ietf-moq-transport-17 Section 9.6:
 * Number of Parameters + Parameters
 * https://github.com/moq-wg/moq-transport/pull/1499
 *
 * リレーサーバー実装用。moqt-js はクライアント専用のため、ランタイムでは使用しない。
 * PBT（Property-Based Testing）でのラウンドトリップテストで使用。
 */
export function encodeRequestOkPayload(msg: RequestOk): Uint8Array {
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
 * RequestOk のペイロードをデコード
 *
 * draft-ietf-moq-transport-17 Section 9.6:
 * Number of Parameters + Parameters
 * https://github.com/moq-wg/moq-transport/pull/1499
 */
export function decodeRequestOkPayload(data: Uint8Array, offset = 0): RequestOk {
  const [parameters] = decodeParameters(data, offset);

  return {
    type: MessageType.REQUEST_OK,
    parameters,
  };
}

/**
 * RequestError のペイロードをエンコード
 *
 * draft-ietf-moq-transport-17 Section 9.7:
 * Error Code + Retry Interval + Error Reason
 * https://github.com/moq-wg/moq-transport/pull/1499
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
 * draft-ietf-moq-transport-17 Section 9.7:
 * Error Code + Retry Interval + Error Reason
 * https://github.com/moq-wg/moq-transport/pull/1499
 */
export function decodeRequestErrorPayload(data: Uint8Array, offset = 0): RequestError {
  const [errorCode, errorCodeSize] = decodeVarint(data, offset);
  offset += errorCodeSize;

  const [retryInterval, retryIntervalSize] = decodeVarint(data, offset);
  offset += retryIntervalSize;

  const [reasonLen, reasonLenSize] = decodeVarint(data, offset);
  offset += reasonLenSize;

  // draft-ietf-moq-transport-17 Section 1.4.4:
  // Reason Phrase の最大長は 1,024 バイト
  if (Number(reasonLen) > MAX_REASON_PHRASE_LENGTH) {
    throw new Error(
      `reason phrase length exceeds maximum: ${reasonLen} > ${MAX_REASON_PHRASE_LENGTH}`,
    );
  }

  const decoder = new TextDecoder();
  const reasonPhrase = decoder.decode(data.slice(offset, offset + Number(reasonLen)));

  return {
    type: MessageType.REQUEST_ERROR,
    errorCode,
    retryInterval,
    reasonPhrase,
  };
}
