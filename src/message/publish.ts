/**
 * MOQT Publish Messages
 * draft-ietf-moq-transport-16 Section 9.13-9.15
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
  decodeParameter,
  decodeTrackNamespace,
  encodeParameter,
  encodeTrackNamespace,
} from "./parameter";
import { MessageType } from "./types";

/**
 * PUBLISH メッセージ (Section 9.13)
 *
 * draft-ietf-moq-transport-16:
 * Track Extensions が追加された。
 * https://github.com/moq-wg/moq-transport/pull/1374
 */
export interface Publish {
  type: typeof MessageType.PUBLISH;
  requestId: bigint;
  trackNamespace: TrackNamespace;
  trackName: Uint8Array;
  trackAlias: bigint;
  parameters: Parameter[];
  trackExtensions: ExtensionHeader[];
}

/**
 * PUBLISH_OK メッセージ (Section 9.14)
 */
export interface PublishOk {
  type: typeof MessageType.PUBLISH_OK;
  requestId: bigint;
  parameters: Parameter[];
}

/**
 * PUBLISH_DONE メッセージ (Section 9.15)
 * draft-15 で stream_count フィールドが追加
 */
export interface PublishDone {
  type: typeof MessageType.PUBLISH_DONE;
  requestId: bigint;
  statusCode: bigint;
  streamCount: bigint;
  reasonPhrase: string;
}

/**
 * Publish のペイロードをエンコード
 *
 * draft-ietf-moq-transport-16 Section 9.13:
 * PUBLISH Message {
 *   Type (i) = 0xB,
 *   Length (16),
 *   Request ID (i),
 *   Track Namespace (..),
 *   Track Name Length (i),
 *   Track Name (..),
 *   Track Alias (i),
 *   Number of Parameters (i),
 *   Parameters (..) ...,
 *   Track Extensions Length (i),
 *   Track Extensions (..)
 * }
 */
export function encodePublishPayload(msg: Publish): Uint8Array {
  const parts: Uint8Array[] = [];

  parts.push(encodeVarint(msg.requestId));
  parts.push(encodeTrackNamespace(msg.trackNamespace));
  parts.push(encodeVarint(msg.trackName.length));
  parts.push(msg.trackName);
  parts.push(encodeVarint(msg.trackAlias));
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
 * Publish のペイロードをデコード
 *
 * リレーサーバー実装用。moqt-js はクライアント専用のため、ランタイムでは使用しない。
 * PBT（Property-Based Testing）でのラウンドトリップテストで使用。
 */
export function decodePublishPayload(data: Uint8Array, offset = 0): Publish {
  let totalConsumed = 0;

  const [requestId, requestIdConsumed] = decodeVarint(data, offset + totalConsumed);
  totalConsumed += requestIdConsumed;

  const [trackNamespace, namespaceConsumed] = decodeTrackNamespace(data, offset + totalConsumed);
  totalConsumed += namespaceConsumed;

  const [nameLen, nameLenConsumed] = decodeVarint(data, offset + totalConsumed);
  totalConsumed += nameLenConsumed;
  const trackName = data.slice(offset + totalConsumed, offset + totalConsumed + Number(nameLen));
  totalConsumed += Number(nameLen);

  const [trackAlias, trackAliasConsumed] = decodeVarint(data, offset + totalConsumed);
  totalConsumed += trackAliasConsumed;

  const [numParams, numParamsConsumed] = decodeVarint(data, offset + totalConsumed);
  totalConsumed += numParamsConsumed;

  const parameters: Parameter[] = [];
  for (let i = 0; i < Number(numParams); i++) {
    const [param, paramConsumed] = decodeParameter(data, offset + totalConsumed);
    parameters.push(param);
    totalConsumed += paramConsumed;
  }

  // Track Extensions
  const [extensionsLen, extensionsLenConsumed] = decodeVarint(data, offset + totalConsumed);
  totalConsumed += extensionsLenConsumed;

  const extensionsData = data.slice(
    offset + totalConsumed,
    offset + totalConsumed + Number(extensionsLen),
  );
  const trackExtensions = decodeExtensionHeaders(extensionsData);

  return {
    type: MessageType.PUBLISH,
    requestId,
    trackNamespace,
    trackName,
    trackAlias,
    parameters,
    trackExtensions,
  };
}

/**
 * PublishOk のペイロードをエンコード
 *
 * リレーサーバー実装用。moqt-js はクライアント専用のため、ランタイムでは使用しない。
 * PBT（Property-Based Testing）でのラウンドトリップテストで使用。
 */
export function encodePublishOkPayload(msg: PublishOk): Uint8Array {
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
 * PublishOk のペイロードをデコード
 */
export function decodePublishOkPayload(data: Uint8Array, offset = 0): PublishOk {
  let totalConsumed = 0;

  const [requestId, requestIdConsumed] = decodeVarint(data, offset + totalConsumed);
  totalConsumed += requestIdConsumed;

  const [numParams, numParamsConsumed] = decodeVarint(data, offset + totalConsumed);
  totalConsumed += numParamsConsumed;

  const parameters: Parameter[] = [];
  for (let i = 0; i < Number(numParams); i++) {
    const [param, paramConsumed] = decodeParameter(data, offset + totalConsumed);
    parameters.push(param);
    totalConsumed += paramConsumed;
  }

  return {
    type: MessageType.PUBLISH_OK,
    requestId,
    parameters,
  };
}

/**
 * PublishDone のペイロードをエンコード
 *
 * Session では個別にエンコードしているため、ランタイムでは使用しない。
 * PBT（Property-Based Testing）でのラウンドトリップテストで使用。
 */
export function encodePublishDonePayload(msg: PublishDone): Uint8Array {
  const encoder = new TextEncoder();
  const reasonBytes = encoder.encode(msg.reasonPhrase);

  const parts: Uint8Array[] = [];
  parts.push(encodeVarint(msg.requestId));
  parts.push(encodeVarint(msg.statusCode));
  parts.push(encodeVarint(msg.streamCount));
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
 * PublishDone のペイロードをデコード
 */
export function decodePublishDonePayload(data: Uint8Array, offset = 0): PublishDone {
  let totalConsumed = 0;

  const [requestId, requestIdConsumed] = decodeVarint(data, offset + totalConsumed);
  totalConsumed += requestIdConsumed;

  const [statusCode, statusCodeConsumed] = decodeVarint(data, offset + totalConsumed);
  totalConsumed += statusCodeConsumed;

  const [streamCount, streamCountConsumed] = decodeVarint(data, offset + totalConsumed);
  totalConsumed += streamCountConsumed;

  const [reasonLen, reasonLenConsumed] = decodeVarint(data, offset + totalConsumed);
  totalConsumed += reasonLenConsumed;

  const reasonBytes = data.slice(
    offset + totalConsumed,
    offset + totalConsumed + Number(reasonLen),
  );
  const reasonPhrase = new TextDecoder().decode(reasonBytes);

  return {
    type: MessageType.PUBLISH_DONE,
    requestId,
    statusCode,
    streamCount,
    reasonPhrase,
  };
}
