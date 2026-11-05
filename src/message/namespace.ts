/**
 * MOQT Namespace Messages
 * draft-ietf-moq-transport-23 Section 9.13 (PUBLISH_NAMESPACE) — 9.18 (PUBLISH_SKIPPED)
 *
 * 制御メッセージのフレーミング (Type / Message Length) は
 * draft-ietf-moq-transport-23 §9 に従う。
 *
 * NAMESPACE は draft-ietf-moq-transport-23 §9.15 で suffix の後ろに
 * Number of Parameters と Parameters を持つ形になった。
 */

import { decodeVarint, encodeVarint } from "../varint";
import { assertLengthWithinData } from "../length";
import { concatUint8Arrays } from "../bytes";
import { ProtocolViolationError, SessionErrorCode } from "../error";
import {
  type Parameter,
  type TrackNamespace,
  MAX_TRACK_NAMESPACE_FIELDS,
  MAX_TRACK_NAMESPACE_SIZE,
  decodeParameters,
  decodeTrackNamespace,
  validateFullTrackNameBytes,
  validateTrackNameNonEmpty,
  encodeParameters,
  encodeTrackNamespace,
} from "./parameter";
import { MessageType } from "./types";

/**
 * prefix を特定できない呼び出しで合成検証に使う空の Track Namespace
 *
 * 受信経路は必ずリクエストで送信した Track Namespace Prefix を渡す。
 * ラウンドトリップ検証のように合成後の Track Namespace を特定できない
 * 呼び出しでは空 prefix として扱い、Suffix 単体の上限だけを判定する。
 * Suffix 単体で上限を超える Track Namespace は prefix が何であっても
 * 上限を超えるため、この扱いで正当なメッセージを誤って拒否することはない。
 */
const EMPTY_TRACK_NAMESPACE: TrackNamespace = { tuple: [] };

/**
 * 受信した Track Namespace Suffix を prefix と合成して §8.7 の上限を検証する
 *
 * draft-ietf-moq-transport-23 §9.15 (NAMESPACE) / §9.16 (NAMESPACE_DONE) /
 * §9.18 (PUBLISH_SKIPPED):
 * これらのメッセージは SUBSCRIBE_NAMESPACE (§9.14) / SUBSCRIBE_TRACKS (§9.17) の
 * Track Namespace Prefix の後ろに連結される Track Namespace Suffix だけを運ぶ。
 * §8.7 の上限は suffix 単体ではなく prefix と連結した Track Namespace に対して
 * 判定しなければならない (decodeTrackNamespace は suffix 単体の上限しか見ない)。
 * そのため受信経路は prefix を渡して本関数を通す。
 *
 * draft-ietf-moq-transport-23 §8.7 (Track Namespace Structure):
 * - "If an endpoint receives a Track Namespace consisting of greater than 32
 *    Track Namespace Fields, it MUST close the session with
 *    INVALID_TRACK_NAMESPACE."
 * - "The length of a Track Namespace is the sum of the Track Namespace Field
 *    Length fields." / "If an endpoint receives a Track Namespace or a Full
 *    Track Name exceeding 4,096 bytes, it MUST close the session with
 *    FIELD_LENGTH_EXCEEDED."
 * - "The length of a Full Track Name is computed as the sum of the Track
 *    Namespace Field Length fields and the Track Name Length field."
 *
 * draft-ietf-moq-transport-23 §12.2 (Session Termination Codes):
 * "When more than one code applies, an endpoint uses DELTA_ENCODING_OVERFLOW
 *  or FIELD_LENGTH_EXCEEDED in preference to the other codes."
 * そのため 4,096 バイト超 (FIELD_LENGTH_EXCEEDED) の判定を、32 フィールド超
 * (INVALID_TRACK_NAMESPACE) を含む他の検証より先に行う。フィールド数を先に
 * 判定すると、両方が成立する入力 (例: prefix 32 フィールド × 100 バイト +
 * suffix 8 フィールド × 200 バイト = 40 フィールド / 4,800 バイト) で
 * INVALID_TRACK_NAMESPACE を返してしまい §12.2 に反する。
 *
 * 各 Field Value が 1 バイト以上であることと Length のワイヤ構造は、suffix 側は
 * decodeTrackNamespace が、prefix 側は送信時の createTrackNamespace /
 * validateTrackNamespaceForSend が検証済みのため、ここでは再検証しない。
 * §8.7 の上限値と 32 フィールドの制限は将来の draft で変わり得るため、
 * 変更時は本関数と decodeTrackNamespace の双方を追随させること。
 *
 * @param trackNamespacePrefix - リクエストで送信した Track Namespace Prefix
 * @param trackNamespaceSuffix - メッセージが運ぶ Track Namespace Suffix
 * @param contextName - エラーメッセージ用のメッセージ名
 * @param trackName - Track Name。持たないメッセージ (NAMESPACE / NAMESPACE_DONE)
 *   では省略し、Full Track Name ではなく Track Namespace の上限だけを判定する
 * @throws ProtocolViolationError 32 フィールド超 (INVALID_TRACK_NAMESPACE) /
 *   4,096 バイト超 (FIELD_LENGTH_EXCEEDED)。両方が成立する場合は §12.2 の
 *   優先順位により FIELD_LENGTH_EXCEEDED
 */
function validateReceivedTrackNamespace(
  trackNamespacePrefix: TrackNamespace,
  trackNamespaceSuffix: TrackNamespace,
  contextName: string,
  trackName?: Uint8Array,
): void {
  const combined: TrackNamespace = {
    tuple: [...trackNamespacePrefix.tuple, ...trackNamespaceSuffix.tuple],
  };

  // draft-ietf-moq-transport-23 §8.7 / §12.2:
  // Track Namespace の長さは Field Length の和。4,096 バイト超は
  // FIELD_LENGTH_EXCEEDED であり、フィールド数 (INVALID_TRACK_NAMESPACE) より
  // 優先するため、最初に判定する。
  let trackNamespaceSize = 0;
  for (const field of combined.tuple) {
    trackNamespaceSize += field.length;
  }
  if (trackNamespaceSize > MAX_TRACK_NAMESPACE_SIZE) {
    throw new ProtocolViolationError(
      `${contextName} track namespace exceeds maximum size: ${trackNamespaceSize} > ${MAX_TRACK_NAMESPACE_SIZE}`,
      SessionErrorCode.FIELD_LENGTH_EXCEEDED,
    );
  }

  // draft-ietf-moq-transport-23 §8.7 / §12.2:
  // Full Track Name の長さは Track Namespace のフィールド長と Track Name Length の和。
  // これも 4,096 バイト超は FIELD_LENGTH_EXCEEDED のため、フィールド数より先に判定する。
  // Track Name を持つメッセージだけ、既存の Full Track Name 検証と規則を共有する。
  if (trackName !== undefined) {
    validateFullTrackNameBytes(combined, trackName);
  }

  // draft-ietf-moq-transport-23 §8.7:
  // サイズ超過が成立しないことを確定させたうえで、フィールド数を判定する。
  if (combined.tuple.length > MAX_TRACK_NAMESPACE_FIELDS) {
    throw new ProtocolViolationError(
      `${contextName} track namespace fields exceeds maximum: ${combined.tuple.length} > ${MAX_TRACK_NAMESPACE_FIELDS}`,
      SessionErrorCode.INVALID_TRACK_NAMESPACE,
    );
  }
}

/**
 * PUBLISH_NAMESPACE メッセージ (Section 9.13 PUBLISH_NAMESPACE)
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
 * NAMESPACE メッセージ (draft-ietf-moq-transport-23 §9.15 NAMESPACE)
 *
 * SUBSCRIBE_NAMESPACE への応答として専用ストリームで送信される。
 * Track Namespace Prefix を除いた Suffix と Parameters を含む。
 *
 * draft-ietf-moq-transport-23 §9.15:
 * NAMESPACE Message {
 *   Type (vi64) = 0x8,
 *   Length (vi64),
 *   Track Namespace Suffix (..),
 *   Number of Parameters (vi64),
 *   Parameters (..) ...
 * }
 *
 * "When Parameters of a NAMESPACE change, the NAMESPACE message is sent again
 *  with the updated Parameters."
 * 同じ suffix の再通知は Parameters の更新を表す (新しい namespace の追加では
 * ない)。§9.19 は受信側が理解できない Message Parameter を INVALID_PARAMETER
 * で拒否することを MUST とする。NAMESPACE に出現できるパラメータは §9.19 の
 * 各定義に列挙が無く、現在の draft では拡張が専用のパラメータを定義して使う。
 */
export interface Namespace {
  type: typeof MessageType.NAMESPACE;
  trackNamespaceSuffix: TrackNamespace;
  parameters: Parameter[];
}

/**
 * NAMESPACE_DONE メッセージ (Section 9.16 NAMESPACE_DONE)
 *
 * SUBSCRIBE_NAMESPACE への応答として専用ストリームで送信される。
 * Track Namespace Prefix を除いた Suffix のみを含む。
 *
 * NAMESPACE_DONE Message {
 *   Type (vi64) = 0xE,
 *   Length (vi64),
 *   Track Namespace Suffix (..)
 * }
 */
export interface NamespaceDone {
  type: typeof MessageType.NAMESPACE_DONE;
  trackNamespaceSuffix: TrackNamespace;
}

/**
 * SUBSCRIBE_NAMESPACE メッセージ (Section 9.14 SUBSCRIBE_NAMESPACE)
 *
 * draft-ietf-moq-transport-23:
 * 旧 SUBSCRIBE_NAMESPACE (0x11) が SUBSCRIBE_NAMESPACE (0x50) と
 * SUBSCRIBE_TRACKS (0x51) に分割された。Subscribe Options フィールドは
 * 廃止され、各メッセージの責務が明確化された。
 *
 * SUBSCRIBE_NAMESPACE は namespace discovery を担当する。
 * 応答として NAMESPACE / NAMESPACE_DONE メッセージが送られてくる。
 *
 * SUBSCRIBE_NAMESPACE Message {
 *   Type (vi64) = 0x50,
 *   Length (vi64),
 *   Request ID (vi64),
 *   Track Namespace Prefix (..),
 *   Number of Parameters (vi64),
 *   Parameters (..) ...
 * }
 *
 * Track Namespace Prefix は 0〜32 タプルを許可する（空のネームスペースも可）。
 * 空のネームスペースはワイルドカードとして機能し、全てのネームスペースにマッチする。
 *
 * draft-ietf-moq-transport-23 §9.14
 */
export interface SubscribeNamespace {
  type: typeof MessageType.SUBSCRIBE_NAMESPACE;
  requestId: bigint;
  trackNamespacePrefix: TrackNamespace;
  parameters: Parameter[];
}

/**
 * SUBSCRIBE_TRACKS メッセージ (Section 9.17 SUBSCRIBE_TRACKS)
 *
 * draft-ietf-moq-transport-23:
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
 *   Length (vi64),
 *   Request ID (vi64),
 *   Track Namespace Prefix (..),
 *   Number of Parameters (vi64),
 *   Parameters (..) ...
 * }
 *
 * draft-ietf-moq-transport-23 §9.17
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

  // draft-ietf-moq-transport-23 §9:
  // "If the length does not match the length of the Message Body,
  //  the receiver MUST close the session with MALFORMED_MESSAGE."
  // Parameters は PUBLISH_NAMESPACE ペイロードの最後のフィールドであり、
  // その後ろに後続データがあると消費バイト数が Message Body 長と一致しないため違反となる
  if (offset + totalConsumed !== data.length) {
    throw new ProtocolViolationError(
      `trailing data in PUBLISH_NAMESPACE: expected ${data.length} bytes, consumed ${offset + totalConsumed}`,
      SessionErrorCode.MALFORMED_MESSAGE,
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
 * draft-ietf-moq-transport-23 §9.15 (NAMESPACE):
 * NAMESPACE Message {
 *   Type (vi64) = 0x8,
 *   Length (vi64),
 *   Track Namespace Suffix (..),
 *   Number of Parameters (vi64),
 *   Parameters (..) ...
 * }
 *
 * 空の Parameters でも Number of Parameters (= 0) を必ず含める。
 * これが無い旧ワイヤは受信側で切り詰めとして扱われる。
 */
export function encodeNamespacePayload(msg: Namespace): Uint8Array {
  return concatUint8Arrays([
    encodeTrackNamespace(msg.trackNamespaceSuffix),
    encodeParameters(msg.parameters),
  ]);
}

/**
 * Namespace のペイロードをデコード
 *
 * draft-ietf-moq-transport-23 §9.15 (NAMESPACE):
 * Track Namespace Suffix の直後の Number of Parameters と Parameters を
 * §9.19 (Control Message Parameters) の規則でデコードする。未知の
 * Message Parameter 型は decodeParameters が INVALID_PARAMETER で拒否するため、
 * 未知 Detail のように読み飛ばすことはしない。
 *
 * パラメータ型が NAMESPACE に出現してよいか (§9.19.1 Parameter Scope) は
 * メッセージ定義側の規則であり、このコードでは検証しない。session の
 * namespace ループが NAMESPACE_ALLOWED_PARAMS で検証する。
 *
 * @param trackNamespacePrefix - SUBSCRIBE_NAMESPACE で送信した Track Namespace
 *   Prefix。Track Namespace Suffix は prefix の後ろに連結されるため、§8.7 の
 *   上限は prefix と合成した Track Namespace で判定する。受信経路は必ず渡し、
 *   省略時は空 prefix (suffix 単体) として検証する
 */
export function decodeNamespacePayload(
  data: Uint8Array,
  offset = 0,
  trackNamespacePrefix?: TrackNamespace,
): Namespace {
  let totalConsumed = 0;

  const [trackNamespaceSuffix, namespaceConsumed] = decodeTrackNamespace(
    data,
    offset + totalConsumed,
  );
  totalConsumed += namespaceConsumed;

  // draft-ietf-moq-transport-23 §9.15 / §8.7:
  // NAMESPACE の Track Namespace Suffix は SUBSCRIBE_NAMESPACE の Track Namespace
  // Prefix の後ろに連結されて 1 つの Track Namespace を成す。32 フィールド /
  // 4,096 バイトの上限は合成後の Track Namespace で判定する
  validateReceivedTrackNamespace(
    trackNamespacePrefix ?? EMPTY_TRACK_NAMESPACE,
    trackNamespaceSuffix,
    "NAMESPACE",
  );

  const [parameters, parametersConsumed] = decodeParameters(data, offset + totalConsumed);
  totalConsumed += parametersConsumed;

  // draft-ietf-moq-transport-23 §9:
  // "If the length does not match the length of the Message Body,
  //  the receiver MUST close the session with MALFORMED_MESSAGE."
  // Parameters は NAMESPACE ペイロードの最後のフィールドであり、
  // その後ろに後続データがあると消費バイト数が Message Body 長と一致しないため違反となる
  if (offset + totalConsumed !== data.length) {
    throw new ProtocolViolationError(
      `trailing data in NAMESPACE: expected ${data.length} bytes, consumed ${offset + totalConsumed}`,
      SessionErrorCode.MALFORMED_MESSAGE,
    );
  }

  return {
    type: MessageType.NAMESPACE,
    trackNamespaceSuffix,
    parameters,
  };
}

/**
 * NamespaceDone のペイロードをエンコード
 *
 * draft-ietf-moq-transport-23 Section 9.16 (NAMESPACE_DONE):
 * NAMESPACE_DONE Message {
 *   Type (vi64) = 0xE,
 *   Length (vi64),
 *   Track Namespace Suffix (..)
 * }
 */
export function encodeNamespaceDonePayload(msg: NamespaceDone): Uint8Array {
  return encodeTrackNamespace(msg.trackNamespaceSuffix);
}

/**
 * NamespaceDone のペイロードをデコード
 *
 * draft-ietf-moq-transport-23 §9.16 (NAMESPACE_DONE):
 * Track Namespace Suffix は SUBSCRIBE_NAMESPACE の Track Namespace Prefix の
 * 後ろに連結されるため、§8.7 の上限は prefix と合成して判定する。
 *
 * @param trackNamespacePrefix - SUBSCRIBE_NAMESPACE で送信した Track Namespace
 *   Prefix。受信経路は必ず渡し、省略時は空 prefix (suffix 単体) として検証する
 */
export function decodeNamespaceDonePayload(
  data: Uint8Array,
  offset = 0,
  trackNamespacePrefix?: TrackNamespace,
): NamespaceDone {
  const [trackNamespaceSuffix, namespaceConsumed] = decodeTrackNamespace(data, offset);

  // draft-ietf-moq-transport-23 §9.16 / §8.7:
  // 32 フィールド / 4,096 バイトの上限は prefix と合成した Track Namespace で判定する
  validateReceivedTrackNamespace(
    trackNamespacePrefix ?? EMPTY_TRACK_NAMESPACE,
    trackNamespaceSuffix,
    "NAMESPACE_DONE",
  );

  // draft-ietf-moq-transport-23 §9:
  // "If the length does not match the length of the Message Body,
  //  the receiver MUST close the session with MALFORMED_MESSAGE."
  // Track Namespace Suffix は NAMESPACE_DONE ペイロードの最後のフィールドであり、
  // その後ろに後続データがあると消費バイト数が Message Body 長と一致しないため違反となる
  if (offset + namespaceConsumed !== data.length) {
    throw new ProtocolViolationError(
      `trailing data in NAMESPACE_DONE: expected ${data.length} bytes, consumed ${offset + namespaceConsumed}`,
      SessionErrorCode.MALFORMED_MESSAGE,
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
 * draft-ietf-moq-transport-23 Section 9.14 (SUBSCRIBE_NAMESPACE):
 * SUBSCRIBE_NAMESPACE Message {
 *   Type (vi64) = 0x50,
 *   Length (vi64),
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
 * draft-ietf-moq-transport-23 Section 9.14 (SUBSCRIBE_NAMESPACE)
 */
export function decodeSubscribeNamespacePayload(data: Uint8Array, offset = 0): SubscribeNamespace {
  let totalConsumed = 0;

  const [requestId, requestIdSize] = decodeVarint(data, offset + totalConsumed);
  totalConsumed += requestIdSize;

  const [trackNamespacePrefix, namespaceSize] = decodeTrackNamespace(data, offset + totalConsumed);
  totalConsumed += namespaceSize;

  const [parameters, parametersConsumed] = decodeParameters(data, offset + totalConsumed);
  totalConsumed += parametersConsumed;

  // draft-ietf-moq-transport-23 §9:
  // "If the length does not match the length of the Message Body,
  //  the receiver MUST close the session with MALFORMED_MESSAGE."
  // Parameters は SUBSCRIBE_NAMESPACE ペイロードの最後のフィールドであり、
  // その後ろに後続データがあると消費バイト数が Message Body 長と一致しないため違反となる
  if (offset + totalConsumed !== data.length) {
    throw new ProtocolViolationError(
      `trailing data in SUBSCRIBE_NAMESPACE: expected ${data.length} bytes, consumed ${offset + totalConsumed}`,
      SessionErrorCode.MALFORMED_MESSAGE,
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
 * draft-ietf-moq-transport-23 Section 9.17 (SUBSCRIBE_TRACKS):
 * SUBSCRIBE_TRACKS Message {
 *   Type (vi64) = 0x51,
 *   Length (vi64),
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
 * draft-ietf-moq-transport-23 Section 9.17 (SUBSCRIBE_TRACKS)
 */
export function decodeSubscribeTracksPayload(data: Uint8Array, offset = 0): SubscribeTracks {
  let totalConsumed = 0;

  const [requestId, requestIdSize] = decodeVarint(data, offset + totalConsumed);
  totalConsumed += requestIdSize;

  const [trackNamespacePrefix, namespaceSize] = decodeTrackNamespace(data, offset + totalConsumed);
  totalConsumed += namespaceSize;

  const [parameters, parametersConsumed] = decodeParameters(data, offset + totalConsumed);
  totalConsumed += parametersConsumed;

  // draft-ietf-moq-transport-23 §9:
  // "If the length does not match the length of the Message Body,
  //  the receiver MUST close the session with MALFORMED_MESSAGE."
  // Parameters は SUBSCRIBE_TRACKS ペイロードの最後のフィールドであり、
  // その後ろに後続データがあると消費バイト数が Message Body 長と一致しないため違反となる
  if (offset + totalConsumed !== data.length) {
    throw new ProtocolViolationError(
      `trailing data in SUBSCRIBE_TRACKS: expected ${data.length} bytes, consumed ${offset + totalConsumed}`,
      SessionErrorCode.MALFORMED_MESSAGE,
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
 * PUBLISH_SKIPPED メッセージ (Section 9.18 PUBLISH_SKIPPED)
 *
 * draft-ietf-moq-transport-23 Section 9.18 (PUBLISH_SKIPPED):
 * Publisher が Track に対する PUBLISH を送信しないことを示す。
 *
 * PUBLISH_SKIPPED Message {
 *   Type (vi64) = 0xF,
 *   Length (vi64),
 *   Track Namespace Suffix (..),
 *   Track Name Length (vi64),
 *   Track Name (..),
 * }
 *
 * draft-ietf-moq-transport-23 Section 3.6.3:
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
 *
 * draft-ietf-moq-transport-23 §9.18 (PUBLISH_SKIPPED):
 * Track Namespace Suffix は SUBSCRIBE_TRACKS の Track Namespace Prefix の後ろに
 * 連結されるため、§8.7 の Track Namespace と Full Track Name の上限は prefix を
 * 含めて判定する。
 *
 * draft-ietf-moq-transport-23 §12.2 (Session Termination Codes):
 * "When more than one code applies, an endpoint uses DELTA_ENCODING_OVERFLOW
 *  or FIELD_LENGTH_EXCEEDED in preference to the other codes."
 * 合成後の 4,096 バイト超 (FIELD_LENGTH_EXCEEDED) と空 Track Name
 * (PROTOCOL_VIOLATION) が同時に成立する入力では FIELD_LENGTH_EXCEEDED を返す。
 * そのためサイズ検証を空 Track Name の判定より先に行う。
 *
 * @param trackNamespacePrefix - SUBSCRIBE_TRACKS で送信した Track Namespace
 *   Prefix。受信経路は必ず渡し、省略時は空 prefix (suffix 単体) として検証する
 */
export function decodePublishSkippedPayload(
  data: Uint8Array,
  offset = 0,
  trackNamespacePrefix?: TrackNamespace,
): PublishSkipped {
  let totalConsumed = 0;

  const [trackNamespaceSuffix, namespaceSize] = decodeTrackNamespace(data, offset + totalConsumed);
  totalConsumed += namespaceSize;

  const [nameLen, nameLenSize] = decodeVarint(data, offset + totalConsumed);
  totalConsumed += nameLenSize;
  assertLengthWithinData(
    "publish skipped track name",
    nameLen,
    offset + totalConsumed,
    data.length,
  );
  const trackName = data.slice(offset + totalConsumed, offset + totalConsumed + Number(nameLen));
  totalConsumed += Number(nameLen);

  // draft-ietf-moq-transport-23 §9.18 / §8.7:
  // Track Namespace Suffix と Track Name は SUBSCRIBE_TRACKS の Track Namespace
  // Prefix の後ろに連結される。32 フィールド / 4,096 バイトの上限は prefix と
  // 合成したうえで、Track Namespace と Full Track Name の双方に対して判定する
  validateReceivedTrackNamespace(
    trackNamespacePrefix ?? EMPTY_TRACK_NAMESPACE,
    trackNamespaceSuffix,
    "PUBLISH_SKIPPED",
    trackName,
  );

  // draft-ietf-moq-transport-23 §2.4.1 (Track Naming):
  // "Each Track Name MUST contain at least one byte.  If an endpoint receives a
  //  Track Name with a length of 0, it MUST close the session with a
  //  PROTOCOL_VIOLATION."
  // draft-ietf-moq-transport-23 §12.2 (Session Termination Codes):
  // "When more than one code applies, an endpoint uses DELTA_ENCODING_OVERFLOW
  //  or FIELD_LENGTH_EXCEEDED in preference to the other codes."
  // 空 Track Name の PROTOCOL_VIOLATION は、合成後の 4,096 バイト超
  // (FIELD_LENGTH_EXCEEDED) と同時に成立し得る。§12.2 の優先順位を守るため、
  // サイズ検証を先に行い、空 Track Name の判定はその後に回す。
  validateTrackNameNonEmpty(trackName, "publish skipped");

  // draft-ietf-moq-transport-23 §9:
  // "If the length does not match the length of the Message Body,
  //  the receiver MUST close the session with MALFORMED_MESSAGE."
  // Track Name は PUBLISH_SKIPPED ペイロードの最後のフィールドであり、
  // その後ろに後続データがあると消費バイト数が Message Body 長と一致しないため違反となる
  if (offset + totalConsumed !== data.length) {
    throw new ProtocolViolationError(
      `trailing data in PUBLISH_SKIPPED: expected ${data.length} bytes, consumed ${offset + totalConsumed}`,
      SessionErrorCode.MALFORMED_MESSAGE,
    );
  }

  return {
    type: MessageType.PUBLISH_SKIPPED,
    trackNamespaceSuffix,
    trackName,
  };
}
