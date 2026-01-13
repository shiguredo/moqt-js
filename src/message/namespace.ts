/**
 * MOQT Namespace Messages
 * draft-ietf-moq-transport-16 Section 9.20-9.24
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
 * PUBLISH_NAMESPACE メッセージ (Section 9.20)
 *
 * パブリッシャーが Track Namespace 内にトラックがあることを通知する。
 */
export interface PublishNamespace {
  type: typeof MessageType.PUBLISH_NAMESPACE;
  requestId: bigint;
  trackNamespace: TrackNamespace;
  parameters: Parameter[];
}

/**
 * PUBLISH_NAMESPACE_DONE メッセージ (Section 9.21)
 *
 * Track Namespace 内の新規サブスクリプションの提供を停止する意図を通知する。
 *
 * draft-ietf-moq-transport-16:
 * Request ID が追加された。
 * https://github.com/moq-wg/moq-transport/pull/1329
 */
export interface PublishNamespaceDone {
  type: typeof MessageType.PUBLISH_NAMESPACE_DONE;
  requestId: bigint;
  trackNamespace: TrackNamespace;
}

/**
 * PUBLISH_NAMESPACE_CANCEL メッセージ (Section 9.22)
 *
 * サブスクライバーが Track Namespace 内の新規サブスクリプションを停止することを通知する。
 *
 * draft-ietf-moq-transport-16:
 * Request ID が追加された。
 * https://github.com/moq-wg/moq-transport/pull/1329
 */
export interface PublishNamespaceCancel {
  type: typeof MessageType.PUBLISH_NAMESPACE_CANCEL;
  requestId: bigint;
  trackNamespace: TrackNamespace;
  errorCode: bigint;
  reasonPhrase: string;
}

/**
 * SUBSCRIBE_NAMESPACE メッセージ (Section 9.23)
 *
 * サブスクライバーがマッチする公開ネームスペースのセットを要求する。
 *
 * draft-ietf-moq-transport-16:
 * Track Namespace Prefix は 0〜32 タプルを許可する（空のネームスペースも可）。
 * 空のネームスペースはワイルドカードとして機能し、全てのネームスペースにマッチする。
 * https://github.com/moq-wg/moq-transport/pull/1393
 */
export interface SubscribeNamespace {
  type: typeof MessageType.SUBSCRIBE_NAMESPACE;
  requestId: bigint;
  trackNamespacePrefix: TrackNamespace;
  parameters: Parameter[];
}

/**
 * UNSUBSCRIBE_NAMESPACE メッセージ (Section 9.24)
 *
 * 指定した Track Namespace Prefix の PUBLISH_NAMESPACE/PUBLISH メッセージに
 * 興味がなくなったことを通知する。
 */
export interface UnsubscribeNamespace {
  type: typeof MessageType.UNSUBSCRIBE_NAMESPACE;
  requestId: bigint;
}

/**
 * PublishNamespace のペイロードをエンコード
 */
export function encodePublishNamespacePayload(msg: PublishNamespace): Uint8Array {
  const parts: Uint8Array[] = [];

  parts.push(encodeVarint(msg.requestId));
  parts.push(encodeTrackNamespace(msg.trackNamespace));
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
 * PublishNamespace のペイロードをデコード
 */
export function decodePublishNamespacePayload(data: Uint8Array, offset = 0): PublishNamespace {
  let totalConsumed = 0;

  const [requestId, requestIdSize] = decodeVarint(data, offset + totalConsumed);
  totalConsumed += requestIdSize;

  const [trackNamespace, namespaceSize] = decodeTrackNamespace(data, offset + totalConsumed);
  totalConsumed += namespaceSize;

  const [numParams, numParamsSize] = decodeVarint(data, offset + totalConsumed);
  totalConsumed += numParamsSize;

  const parameters: Parameter[] = [];
  for (let i = 0; i < Number(numParams); i++) {
    const [param, paramSize] = decodeParameter(data, offset + totalConsumed);
    parameters.push(param);
    totalConsumed += paramSize;
  }

  return {
    type: MessageType.PUBLISH_NAMESPACE,
    requestId,
    trackNamespace,
    parameters,
  };
}

/**
 * PublishNamespaceDone のペイロードをエンコード
 *
 * draft-ietf-moq-transport-16 Section 9.21:
 * PUBLISH_NAMESPACE_DONE Message {
 *   Type (i) = 0x9,
 *   Length (16),
 *   Request ID (i),
 *   Track Namespace (..)
 * }
 */
export function encodePublishNamespaceDonePayload(msg: PublishNamespaceDone): Uint8Array {
  const parts: Uint8Array[] = [];

  parts.push(encodeVarint(msg.requestId));
  parts.push(encodeTrackNamespace(msg.trackNamespace));

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
 * PublishNamespaceDone のペイロードをデコード
 *
 * Subscriber が Publisher の終了を検知するために使用。
 * moqt-js はクライアント専用だが、現在 Session では未実装。
 * TODO: PUBLISH_NAMESPACE_DONE 受信処理の実装。
 * PBT（Property-Based Testing）でのラウンドトリップテストで使用。
 */
export function decodePublishNamespaceDonePayload(
  data: Uint8Array,
  offset = 0,
): PublishNamespaceDone {
  let totalConsumed = 0;

  const [requestId, requestIdSize] = decodeVarint(data, offset + totalConsumed);
  totalConsumed += requestIdSize;

  const [trackNamespace] = decodeTrackNamespace(data, offset + totalConsumed);

  return {
    type: MessageType.PUBLISH_NAMESPACE_DONE,
    requestId,
    trackNamespace,
  };
}

/**
 * PublishNamespaceCancel のペイロードをエンコード
 *
 * リレーサーバー実装用。moqt-js はクライアント専用のため、ランタイムでは使用しない。
 * PBT（Property-Based Testing）でのラウンドトリップテストで使用。
 *
 * draft-ietf-moq-transport-16 Section 9.22:
 * PUBLISH_NAMESPACE_CANCEL Message {
 *   Type (i) = 0xC,
 *   Length (16),
 *   Request ID (i),
 *   Track Namespace (..),
 *   Error Code (i),
 *   Error Reason (Reason Phrase)
 * }
 */
export function encodePublishNamespaceCancelPayload(msg: PublishNamespaceCancel): Uint8Array {
  const parts: Uint8Array[] = [];

  parts.push(encodeVarint(msg.requestId));
  parts.push(encodeTrackNamespace(msg.trackNamespace));
  parts.push(encodeVarint(msg.errorCode));

  const reasonBytes = new TextEncoder().encode(msg.reasonPhrase);
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
 * PublishNamespaceCancel のペイロードをデコード
 */
export function decodePublishNamespaceCancelPayload(
  data: Uint8Array,
  offset = 0,
): PublishNamespaceCancel {
  let totalConsumed = 0;

  const [requestId, requestIdSize] = decodeVarint(data, offset + totalConsumed);
  totalConsumed += requestIdSize;

  const [trackNamespace, namespaceSize] = decodeTrackNamespace(data, offset + totalConsumed);
  totalConsumed += namespaceSize;

  const [errorCode, errorCodeSize] = decodeVarint(data, offset + totalConsumed);
  totalConsumed += errorCodeSize;

  const [reasonLen, reasonLenSize] = decodeVarint(data, offset + totalConsumed);
  totalConsumed += reasonLenSize;

  const reasonBytes = data.slice(
    offset + totalConsumed,
    offset + totalConsumed + Number(reasonLen),
  );
  const reasonPhrase = new TextDecoder().decode(reasonBytes);

  return {
    type: MessageType.PUBLISH_NAMESPACE_CANCEL,
    requestId,
    trackNamespace,
    errorCode,
    reasonPhrase,
  };
}

/**
 * SubscribeNamespace のペイロードをエンコード
 */
export function encodeSubscribeNamespacePayload(msg: SubscribeNamespace): Uint8Array {
  const parts: Uint8Array[] = [];

  parts.push(encodeVarint(msg.requestId));
  parts.push(encodeTrackNamespace(msg.trackNamespacePrefix));
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
 * SubscribeNamespace のペイロードをデコード
 *
 * リレーサーバー実装用。moqt-js はクライアント専用のため、ランタイムでは使用しない。
 * PBT（Property-Based Testing）でのラウンドトリップテストで使用。
 */
export function decodeSubscribeNamespacePayload(data: Uint8Array, offset = 0): SubscribeNamespace {
  let totalConsumed = 0;

  const [requestId, requestIdSize] = decodeVarint(data, offset + totalConsumed);
  totalConsumed += requestIdSize;

  const [trackNamespacePrefix, namespaceSize] = decodeTrackNamespace(data, offset + totalConsumed);
  totalConsumed += namespaceSize;

  const [numParams, numParamsSize] = decodeVarint(data, offset + totalConsumed);
  totalConsumed += numParamsSize;

  const parameters: Parameter[] = [];
  for (let i = 0; i < Number(numParams); i++) {
    const [param, paramSize] = decodeParameter(data, offset + totalConsumed);
    parameters.push(param);
    totalConsumed += paramSize;
  }

  return {
    type: MessageType.SUBSCRIBE_NAMESPACE,
    requestId,
    trackNamespacePrefix,
    parameters,
  };
}

/**
 * UnsubscribeNamespace のペイロードをエンコード
 */
export function encodeUnsubscribeNamespacePayload(msg: UnsubscribeNamespace): Uint8Array {
  return encodeVarint(msg.requestId);
}

/**
 * UnsubscribeNamespace のペイロードをデコード
 *
 * リレーサーバー実装用。moqt-js はクライアント専用のため、ランタイムでは使用しない。
 * PBT（Property-Based Testing）でのラウンドトリップテストで使用。
 */
export function decodeUnsubscribeNamespacePayload(
  data: Uint8Array,
  offset = 0,
): UnsubscribeNamespace {
  const [requestId] = decodeVarint(data, offset);

  return {
    type: MessageType.UNSUBSCRIBE_NAMESPACE,
    requestId,
  };
}
