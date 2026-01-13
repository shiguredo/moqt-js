/**
 * MOQT Session Messages
 * draft-ietf-moq-transport-16 Section 9.4-9.8
 */

import { decodeVarint, encodeVarint } from "../varint";
import { type Parameter, decodeParameter, encodeParameter } from "./parameter";
import { MessageType } from "./types";

/**
 * GOAWAY メッセージ (Section 9.4)
 *
 * セッションを終了する意図を通知する。
 * サーバーはセッションマイグレーション用のオプショナル URI を含めることができる。
 */
export interface Goaway {
  type: typeof MessageType.GOAWAY;
  newSessionUri: string;
}

/**
 * MAX_REQUEST_ID メッセージ (Section 9.5)
 *
 * ピアが送信できるリクエスト数を増加させる。
 */
export interface MaxRequestId {
  type: typeof MessageType.MAX_REQUEST_ID;
  maxRequestId: bigint;
}

/**
 * REQUESTS_BLOCKED メッセージ (Section 9.6)
 *
 * リクエスト ID が MAX_REQUEST_ID を超えるため、
 * 新しいリクエストを送信できないことを通知する。
 */
export interface RequestsBlocked {
  type: typeof MessageType.REQUESTS_BLOCKED;
  maximumRequestId: bigint;
}

/**
 * REQUEST_OK メッセージ (Section 9.7)
 *
 * SUBSCRIBE_UPDATE, TRACK_STATUS, SUBSCRIBE_NAMESPACE,
 * PUBLISH_NAMESPACE リクエストへの成功応答。
 */
export interface RequestOk {
  type: typeof MessageType.REQUEST_OK;
  requestId: bigint;
  parameters: Parameter[];
}

/**
 * REQUEST_ERROR メッセージ (Section 9.8)
 *
 * リクエスト（SUBSCRIBE, FETCH, PUBLISH, SUBSCRIBE_NAMESPACE,
 * PUBLISH_NAMESPACE, TRACK_STATUS）への失敗応答。
 *
 * draft-ietf-moq-transport-16:
 * Retry Interval: 再試行までに待つべきミリ秒 + 1
 * - 0: 再試行すべきではない
 * - 1 以上: 再試行可能（1 は即座の再試行を許可）
 */
export interface RequestError {
  type: typeof MessageType.REQUEST_ERROR;
  requestId: bigint;
  errorCode: bigint;
  retryInterval: bigint;
  reasonPhrase: string;
}

/**
 * Goaway のペイロードをエンコード
 */
export function encodeGoawayPayload(msg: Goaway): Uint8Array {
  const uriBytes = new TextEncoder().encode(msg.newSessionUri);
  const parts: Uint8Array[] = [];

  parts.push(encodeVarint(uriBytes.length));
  parts.push(uriBytes);

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

  const uriBytes = data.slice(offset, offset + Number(uriLength));
  const newSessionUri = new TextDecoder().decode(uriBytes);

  return {
    type: MessageType.GOAWAY,
    newSessionUri,
  };
}

/**
 * MaxRequestId のペイロードをエンコード
 */
export function encodeMaxRequestIdPayload(msg: MaxRequestId): Uint8Array {
  return encodeVarint(msg.maxRequestId);
}

/**
 * MaxRequestId のペイロードをデコード
 */
export function decodeMaxRequestIdPayload(data: Uint8Array, offset = 0): MaxRequestId {
  const [maxRequestId] = decodeVarint(data, offset);

  return {
    type: MessageType.MAX_REQUEST_ID,
    maxRequestId,
  };
}

/**
 * RequestsBlocked のペイロードをエンコード
 */
export function encodeRequestsBlockedPayload(msg: RequestsBlocked): Uint8Array {
  return encodeVarint(msg.maximumRequestId);
}

/**
 * RequestsBlocked のペイロードをデコード
 */
export function decodeRequestsBlockedPayload(data: Uint8Array, offset = 0): RequestsBlocked {
  const [maximumRequestId] = decodeVarint(data, offset);

  return {
    type: MessageType.REQUESTS_BLOCKED,
    maximumRequestId,
  };
}

/**
 * RequestOk のペイロードをエンコード
 *
 * リレーサーバー実装用。moqt-js はクライアント専用のため、ランタイムでは使用しない。
 * PBT（Property-Based Testing）でのラウンドトリップテストで使用。
 */
export function encodeRequestOkPayload(msg: RequestOk): Uint8Array {
  const parts: Uint8Array[] = [];

  parts.push(encodeVarint(msg.requestId));
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
 * RequestOk のペイロードをデコード
 */
export function decodeRequestOkPayload(data: Uint8Array, offset = 0): RequestOk {
  const [requestId, requestIdSize] = decodeVarint(data, offset);
  offset += requestIdSize;

  const [numParams, numParamsSize] = decodeVarint(data, offset);
  offset += numParamsSize;

  const parameters: Parameter[] = [];
  for (let i = 0; i < numParams; i++) {
    const [param, paramSize] = decodeParameter(data, offset);
    parameters.push(param);
    offset += paramSize;
  }

  return {
    type: MessageType.REQUEST_OK,
    requestId,
    parameters,
  };
}

/**
 * RequestError のペイロードをエンコード
 *
 * リレーサーバー実装用。moqt-js はクライアント専用のため、ランタイムでは使用しない。
 * PBT（Property-Based Testing）でのラウンドトリップテストで使用。
 *
 * draft-ietf-moq-transport-16 Section 9.8:
 * REQUEST_ERROR Message {
 *   Type (i) = 0x5,
 *   Length (16),
 *   Request ID (i),
 *   Error Code (i),
 *   Retry Interval (i),
 *   Error Reason (Reason Phrase),
 * }
 */
export function encodeRequestErrorPayload(msg: RequestError): Uint8Array {
  const encoder = new TextEncoder();
  const reasonBytes = encoder.encode(msg.reasonPhrase);

  const parts: Uint8Array[] = [];
  parts.push(encodeVarint(msg.requestId));
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
 */
export function decodeRequestErrorPayload(data: Uint8Array, offset = 0): RequestError {
  const [requestId, requestIdSize] = decodeVarint(data, offset);
  offset += requestIdSize;

  const [errorCode, errorCodeSize] = decodeVarint(data, offset);
  offset += errorCodeSize;

  const [retryInterval, retryIntervalSize] = decodeVarint(data, offset);
  offset += retryIntervalSize;

  const [reasonLen, reasonLenSize] = decodeVarint(data, offset);
  offset += reasonLenSize;

  const decoder = new TextDecoder();
  const reasonPhrase = decoder.decode(data.slice(offset, offset + Number(reasonLen)));

  return {
    type: MessageType.REQUEST_ERROR,
    requestId,
    errorCode,
    retryInterval,
    reasonPhrase,
  };
}
