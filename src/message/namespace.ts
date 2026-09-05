/**
 * MOQT Namespace Messages
 * draft-ietf-moq-transport-20 Section 10.16 (PUBLISH_NAMESPACE) — 10.21 (PUBLISH_SKIPPED)
 */

import { decodeVarint, encodeVarint } from "../varint";
import { ProtocolViolationError } from "../error";
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
 * PUBLISH_NAMESPACE メッセージ (Section 10.16 PUBLISH_NAMESPACE)
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
 * NAMESPACE メッセージ (Section 10.17 NAMESPACE)
 *
 * SUBSCRIBE_NAMESPACE への応答として専用ストリームで送信される。
 * Track Namespace Prefix を除いた Suffix のみを含む。
 *
 * NAMESPACE Message {
 *   Type (i) = 0x8,
 *   Length (16),
 *   Track Namespace Suffix (..)
 * }
 */
export interface Namespace {
  type: typeof MessageType.NAMESPACE;
  trackNamespaceSuffix: TrackNamespace;
}

/**
 * NAMESPACE_DONE メッセージ (Section 10.18 NAMESPACE_DONE)
 *
 * SUBSCRIBE_NAMESPACE への応答として専用ストリームで送信される。
 * Track Namespace Prefix を除いた Suffix のみを含む。
 *
 * NAMESPACE_DONE Message {
 *   Type (i) = 0xE,
 *   Length (16),
 *   Track Namespace Suffix (..)
 * }
 */
export interface NamespaceDone {
  type: typeof MessageType.NAMESPACE_DONE;
  trackNamespaceSuffix: TrackNamespace;
}

/**
 * SUBSCRIBE_NAMESPACE メッセージ (Section 10.19 SUBSCRIBE_NAMESPACE)
 *
 * draft-ietf-moq-transport-20:
 * 旧 SUBSCRIBE_NAMESPACE (0x11) が SUBSCRIBE_NAMESPACE (0x50) と
 * SUBSCRIBE_TRACKS (0x51) に分割された。Subscribe Options フィールドは
 * 廃止され、各メッセージの責務が明確化された。
 *
 * SUBSCRIBE_NAMESPACE は namespace discovery を担当する。
 * 応答として NAMESPACE / NAMESPACE_DONE メッセージが送られてくる。
 *
 * SUBSCRIBE_NAMESPACE Message {
 *   Type (vi64) = 0x50,
 *   Length (16),
 *   Request ID (vi64),
 *   Track Namespace Prefix (..),
 *   Number of Parameters (vi64),
 *   Parameters (..) ...
 * }
 *
 * Track Namespace Prefix は 0〜32 タプルを許可する（空のネームスペースも可）。
 * 空のネームスペースはワイルドカードとして機能し、全てのネームスペースにマッチする。
 *
 * draft-ietf-moq-transport-20 §10.19
 */
export interface SubscribeNamespace {
  type: typeof MessageType.SUBSCRIBE_NAMESPACE;
  requestId: bigint;
  trackNamespacePrefix: TrackNamespace;
  parameters: Parameter[];
}

/**
 * SUBSCRIBE_TRACKS メッセージ (Section 10.20 SUBSCRIBE_TRACKS)
 *
 * draft-ietf-moq-transport-20:
 * 旧 SUBSCRIBE_NAMESPACE (0x11) が SUBSCRIBE_NAMESPACE (0x50) と
 * SUBSCRIBE_TRACKS (0x51) に分割された。
 *
 * SUBSCRIBE_TRACKS は track subscription を担当する。Publisher は
 * マッチするネームスペース内のトラックに対して PUBLISH メッセージを
 * 新規双方向ストリームで送信する。応答ストリームでは PUBLISH_SKIPPED
 * のみが追加で送られる。
 *
 * SUBSCRIBE_TRACKS Message {
 *   Type (vi64) = 0x51,
 *   Length (16),
 *   Request ID (vi64),
 *   Track Namespace Prefix (..),
 *   Number of Parameters (vi64),
 *   Parameters (..) ...
 * }
 *
 * draft-ietf-moq-transport-20 §10.20
 */
export interface SubscribeTracks {
  type: typeof MessageType.SUBSCRIBE_TRACKS;
  requestId: bigint;
  trackNamespacePrefix: TrackNamespace;
  parameters: Parameter[];
}

/**
 * PublishNamespace のペイロードをエンコード
 */
export function encodePublishNamespacePayload(msg: PublishNamespace): Uint8Array {
  const parts: Uint8Array[] = [];

  parts.push(encodeVarint(msg.requestId));
  parts.push(encodeTrackNamespace(msg.trackNamespace));
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
 * PublishNamespace のペイロードをデコード
 */
export function decodePublishNamespacePayload(data: Uint8Array, offset = 0): PublishNamespace {
  let totalConsumed = 0;

  const [requestId, requestIdSize] = decodeVarint(data, offset + totalConsumed);
  totalConsumed += requestIdSize;

  const [trackNamespace, namespaceSize] = decodeTrackNamespace(data, offset + totalConsumed);
  totalConsumed += namespaceSize;

  const [parameters, parametersConsumed] = decodeParameters(data, offset + totalConsumed);
  totalConsumed += parametersConsumed;

  // draft-ietf-moq-transport-20 Section 10:
  // "If the length does not match the length of the Message Body,
  //  the receiver MUST close the session with a PROTOCOL_VIOLATION."
  // Parameters は PUBLISH_NAMESPACE ペイロードの最後のフィールドであり、
  // その後ろに後続データがあると消費バイト数が Message Body 長と一致しないため違反となる
  if (offset + totalConsumed !== data.length) {
    throw new ProtocolViolationError(
      `trailing data in PUBLISH_NAMESPACE: expected ${data.length} bytes, consumed ${offset + totalConsumed}`,
    );
  }

  return {
    type: MessageType.PUBLISH_NAMESPACE,
    requestId,
    trackNamespace,
    parameters,
  };
}

/**
 * Namespace のペイロードをエンコード
 *
 * draft-ietf-moq-transport-20 Section 10.17 (NAMESPACE):
 * NAMESPACE Message {
 *   Type (i) = 0x8,
 *   Length (16),
 *   Track Namespace Suffix (..)
 * }
 */
export function encodeNamespacePayload(msg: Namespace): Uint8Array {
  return encodeTrackNamespace(msg.trackNamespaceSuffix);
}

/**
 * Namespace のペイロードをデコード
 */
export function decodeNamespacePayload(data: Uint8Array, offset = 0): Namespace {
  const [trackNamespaceSuffix, namespaceConsumed] = decodeTrackNamespace(data, offset);

  // draft-ietf-moq-transport-20 Section 10:
  // "If the length does not match the length of the Message Body,
  //  the receiver MUST close the session with a PROTOCOL_VIOLATION."
  // Track Namespace Suffix は NAMESPACE ペイロードの最後のフィールドであり、
  // その後ろに後続データがあると消費バイト数が Message Body 長と一致しないため違反となる
  if (offset + namespaceConsumed !== data.length) {
    throw new ProtocolViolationError(
      `trailing data in NAMESPACE: expected ${data.length} bytes, consumed ${offset + namespaceConsumed}`,
    );
  }

  return {
    type: MessageType.NAMESPACE,
    trackNamespaceSuffix,
  };
}

/**
 * NamespaceDone のペイロードをエンコード
 *
 * draft-ietf-moq-transport-20 Section 10.18 (NAMESPACE_DONE):
 * NAMESPACE_DONE Message {
 *   Type (i) = 0xE,
 *   Length (16),
 *   Track Namespace Suffix (..)
 * }
 */
export function encodeNamespaceDonePayload(msg: NamespaceDone): Uint8Array {
  return encodeTrackNamespace(msg.trackNamespaceSuffix);
}

/**
 * NamespaceDone のペイロードをデコード
 */
export function decodeNamespaceDonePayload(data: Uint8Array, offset = 0): NamespaceDone {
  const [trackNamespaceSuffix, namespaceConsumed] = decodeTrackNamespace(data, offset);

  // draft-ietf-moq-transport-20 Section 10:
  // "If the length does not match the length of the Message Body,
  //  the receiver MUST close the session with a PROTOCOL_VIOLATION."
  // Track Namespace Suffix は NAMESPACE_DONE ペイロードの最後のフィールドであり、
  // その後ろに後続データがあると消費バイト数が Message Body 長と一致しないため違反となる
  if (offset + namespaceConsumed !== data.length) {
    throw new ProtocolViolationError(
      `trailing data in NAMESPACE_DONE: expected ${data.length} bytes, consumed ${offset + namespaceConsumed}`,
    );
  }

  return {
    type: MessageType.NAMESPACE_DONE,
    trackNamespaceSuffix,
  };
}

/**
 * SubscribeNamespace のペイロードをエンコード
 *
 * draft-ietf-moq-transport-20 Section 10.19 (SUBSCRIBE_NAMESPACE):
 * SUBSCRIBE_NAMESPACE Message {
 *   Type (vi64) = 0x50,
 *   Length (16),
 *   Request ID (vi64),
 *   Track Namespace Prefix (..),
 *   Number of Parameters (vi64),
 *   Parameters (..) ...
 * }
 */
export function encodeSubscribeNamespacePayload(msg: SubscribeNamespace): Uint8Array {
  const parts: Uint8Array[] = [];

  parts.push(encodeVarint(msg.requestId));
  parts.push(encodeTrackNamespace(msg.trackNamespacePrefix));
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
 * SubscribeNamespace のペイロードをデコード
 *
 * draft-ietf-moq-transport-20 Section 10.19 (SUBSCRIBE_NAMESPACE)
 */
export function decodeSubscribeNamespacePayload(data: Uint8Array, offset = 0): SubscribeNamespace {
  let totalConsumed = 0;

  const [requestId, requestIdSize] = decodeVarint(data, offset + totalConsumed);
  totalConsumed += requestIdSize;

  const [trackNamespacePrefix, namespaceSize] = decodeTrackNamespace(data, offset + totalConsumed);
  totalConsumed += namespaceSize;

  const [parameters, parametersConsumed] = decodeParameters(data, offset + totalConsumed);
  totalConsumed += parametersConsumed;

  // draft-ietf-moq-transport-20 Section 10:
  // "If the length does not match the length of the Message Body,
  //  the receiver MUST close the session with a PROTOCOL_VIOLATION."
  // Parameters は SUBSCRIBE_NAMESPACE ペイロードの最後のフィールドであり、
  // その後ろに後続データがあると消費バイト数が Message Body 長と一致しないため違反となる
  if (offset + totalConsumed !== data.length) {
    throw new ProtocolViolationError(
      `trailing data in SUBSCRIBE_NAMESPACE: expected ${data.length} bytes, consumed ${offset + totalConsumed}`,
    );
  }

  return {
    type: MessageType.SUBSCRIBE_NAMESPACE,
    requestId,
    trackNamespacePrefix,
    parameters,
  };
}

/**
 * SubscribeTracks のペイロードをエンコード
 *
 * draft-ietf-moq-transport-20 Section 10.20 (SUBSCRIBE_TRACKS):
 * SUBSCRIBE_TRACKS Message {
 *   Type (vi64) = 0x51,
 *   Length (16),
 *   Request ID (vi64),
 *   Track Namespace Prefix (..),
 *   Number of Parameters (vi64),
 *   Parameters (..) ...
 * }
 *
 * SUBSCRIBE_NAMESPACE と同構造で Subscribe Options を持たない。
 */
export function encodeSubscribeTracksPayload(msg: SubscribeTracks): Uint8Array {
  const parts: Uint8Array[] = [];

  parts.push(encodeVarint(msg.requestId));
  parts.push(encodeTrackNamespace(msg.trackNamespacePrefix));
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
 * SubscribeTracks のペイロードをデコード
 *
 * draft-ietf-moq-transport-20 Section 10.20 (SUBSCRIBE_TRACKS)
 */
export function decodeSubscribeTracksPayload(data: Uint8Array, offset = 0): SubscribeTracks {
  let totalConsumed = 0;

  const [requestId, requestIdSize] = decodeVarint(data, offset + totalConsumed);
  totalConsumed += requestIdSize;

  const [trackNamespacePrefix, namespaceSize] = decodeTrackNamespace(data, offset + totalConsumed);
  totalConsumed += namespaceSize;

  const [parameters, parametersConsumed] = decodeParameters(data, offset + totalConsumed);
  totalConsumed += parametersConsumed;

  // draft-ietf-moq-transport-20 Section 10:
  // "If the length does not match the length of the Message Body,
  //  the receiver MUST close the session with a PROTOCOL_VIOLATION."
  // Parameters は SUBSCRIBE_TRACKS ペイロードの最後のフィールドであり、
  // その後ろに後続データがあると消費バイト数が Message Body 長と一致しないため違反となる
  if (offset + totalConsumed !== data.length) {
    throw new ProtocolViolationError(
      `trailing data in SUBSCRIBE_TRACKS: expected ${data.length} bytes, consumed ${offset + totalConsumed}`,
    );
  }

  return {
    type: MessageType.SUBSCRIBE_TRACKS,
    requestId,
    trackNamespacePrefix,
    parameters,
  };
}

/**
 * PUBLISH_SKIPPED メッセージ (Section 10.21 PUBLISH_SKIPPED)
 *
 * draft-ietf-moq-transport-20 Section 10.21 (PUBLISH_SKIPPED):
 * Publisher が Track に対する PUBLISH を送信しないことを示す。
 *
 * PUBLISH_SKIPPED Message {
 *   Type (vi64) = 0xF,
 *   Length (16),
 *   Track Namespace Suffix (..),
 *   Track Name Length (vi64),
 *   Track Name (..),
 * }
 *
 * draft-ietf-moq-transport-20 Section 6.1:
 * "or any other reason" — 理由はストリーム不足に限定されない。
 * MUST NOT send a PUBLISH for a Track after PUBLISH_SKIPPED, scoped to a single PUBLISH.
 */
export interface PublishSkipped {
  type: typeof MessageType.PUBLISH_SKIPPED;
  trackNamespaceSuffix: TrackNamespace;
  trackName: Uint8Array;
}

/**
 * PublishSkipped のペイロードをエンコード
 */
export function encodePublishSkippedPayload(msg: PublishSkipped): Uint8Array {
  const parts: Uint8Array[] = [];

  parts.push(encodeTrackNamespace(msg.trackNamespaceSuffix));
  parts.push(encodeVarint(msg.trackName.length));
  parts.push(msg.trackName);

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
 * PublishSkipped のペイロードをデコード
 */
export function decodePublishSkippedPayload(data: Uint8Array, offset = 0): PublishSkipped {
  let totalConsumed = 0;

  const [trackNamespaceSuffix, namespaceSize] = decodeTrackNamespace(data, offset + totalConsumed);
  totalConsumed += namespaceSize;

  const [nameLen, nameLenSize] = decodeVarint(data, offset + totalConsumed);
  totalConsumed += nameLenSize;
  const trackName = data.slice(offset + totalConsumed, offset + totalConsumed + Number(nameLen));
  totalConsumed += Number(nameLen);

  // draft-ietf-moq-transport-20 Section 10:
  // "If the length does not match the length of the Message Body,
  //  the receiver MUST close the session with a PROTOCOL_VIOLATION."
  // Track Name は PUBLISH_SKIPPED ペイロードの最後のフィールドであり、
  // その後ろに後続データがあると消費バイト数が Message Body 長と一致しないため違反となる
  if (offset + totalConsumed !== data.length) {
    throw new ProtocolViolationError(
      `trailing data in PUBLISH_SKIPPED: expected ${data.length} bytes, consumed ${offset + totalConsumed}`,
    );
  }

  return {
    type: MessageType.PUBLISH_SKIPPED,
    trackNamespaceSuffix,
    trackName,
  };
}
