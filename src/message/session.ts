/**
 * MOQT Session Messages
 * draft-ietf-moq-transport-23 Section 9.2 (GOAWAY) — 9.4 (REQUEST_ERROR)
 *
 * 制御メッセージのフレーミング (Type / Message Length) は
 * draft-ietf-moq-transport-23 §9 に従う。
 */

import { decodeVarint, encodeVarint, MAX_VARINT } from "../varint";
import { assertLengthWithinData } from "../length";
import {
  MAX_REASON_PHRASE_LENGTH,
  type Parameter,
  type TrackNamespace,
  decodeParameters,
  decodeTrackNamespace,
  encodeParameters,
  encodeTrackNamespace,
  validateFullTrackNameBytes,
} from "./parameter";
import { MessageType } from "./types";
import {
  IncompleteDataError,
  ProtocolViolationError,
  RequestErrorCode,
  SessionErrorCode,
} from "../error";
import { type Property, decodeProperties, encodeProperties } from "../properties";

/**
 * GOAWAY メッセージ (Section 9.2)
 *
 * draft-ietf-moq-transport-23 Section 9.2 (GOAWAY):
 *
 * GOAWAY Message {
 *   Type (vi64) = 0x10,
 *   Length (vi64),
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
 * REQUEST_OK メッセージ (Section 9.3)
 *
 * draft-ietf-moq-transport-23:
 * リクエストへの成功応答。双方向ストリーム上で送信されるため、
 * ストリーム自体がリクエストを特定し、Request ID は不要。
 * draft-ietf-moq-transport-23 Section 6.4.2.1
 *
 * REQUEST_OK Message {
 *   Type (vi64) = 0x7,
 *   Length (vi64),
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
 * REDIRECT Error Detail の Value (Section 9.4.2.1)
 *
 * draft-ietf-moq-transport-23 Section 9.4.2.1 (REDIRECT):
 *
 * REDIRECT Error Detail {
 *   Type (vi64) = 0x01,
 *   Length (vi64),
 *   Connect URI Length (vi64),
 *   Connect URI (..),
 *   Track Namespace (..),
 *   Track Name Length (vi64),
 *   Track Name (..),
 * }
 *
 * Type と Length は Error Details の KVP として扱うため、本構造体は Value 部分
 * だけを表す。Track Name は namespace-scoped な要求 (SUBSCRIBE_NAMESPACE /
 * PUBLISH_NAMESPACE / SUBSCRIBE_TRACKS) では空でなければならない (§9.4.2.1 の
 * MUST)。この scope 依存の検証は要求文脈を知る呼び出し側が行う。本構造体の
 * デコードは空の Track Name を許容する。
 */
export interface Redirect {
  connectUri: string;
  trackNamespace: TrackNamespace;
  trackName: Uint8Array;
}

/**
 * REDIRECT Error Detail の Value をエンコード
 *
 * draft-ietf-moq-transport-23 Section 9.4.2.1 (REDIRECT)
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
 * REDIRECT Error Detail の Value をデコード
 *
 * draft-ietf-moq-transport-23 Section 9.4.2.1 (REDIRECT)
 *
 * 注: Connect URI に最大長の規定はない (8,192 バイト上限は GOAWAY の
 * New Session URI (§9.2) にのみ存在する)。宣言された Length が
 * 実データを超える過剰宣言は破損であり、宣言時点で拒否する
 * (呼び出し側が Error Detail の Length で切り出した Value を渡す)。
 *
 * @returns [redirect, consumed bytes]
 */
export function decodeRedirect(data: Uint8Array, offset: number): [Redirect, number] {
  let totalConsumed = 0;

  const [uriLength, uriLengthSize] = decodeVarint(data, offset + totalConsumed);
  totalConsumed += uriLengthSize;

  assertLengthWithinData("redirect URI", uriLength, offset + totalConsumed, data.length);
  const uriBytes = data.slice(offset + totalConsumed, offset + totalConsumed + Number(uriLength));
  const connectUri = new TextDecoder().decode(uriBytes);
  totalConsumed += Number(uriLength);

  const [trackNamespace, namespaceSize] = decodeTrackNamespace(data, offset + totalConsumed);
  totalConsumed += namespaceSize;

  const [trackNameLen, trackNameLenSize] = decodeVarint(data, offset + totalConsumed);
  totalConsumed += trackNameLenSize;

  assertLengthWithinData("redirect track name", trackNameLen, offset + totalConsumed, data.length);
  const trackName = data.slice(
    offset + totalConsumed,
    offset + totalConsumed + Number(trackNameLen),
  );
  totalConsumed += Number(trackNameLen);

  // draft-ietf-moq-transport-23 §8.7:
  // Full Track Name (Namespace + Track Name 合計) が 4096 バイト超過は
  // FIELD_LENGTH_EXCEEDED でセッションを閉じる
  // ワイヤバイト長で計測する (不正 UTF-8 の置換による誤計測を防ぐ)
  validateFullTrackNameBytes(trackNamespace, trackName);

  return [{ connectUri, trackNamespace, trackName }, totalConsumed];
}

/**
 * Error Detail Types (Section 16.11)
 *
 * draft-ietf-moq-transport-23 Section 16.11 (Error Detail Types):
 * REQUEST_ERROR の末尾は §8.3 の Key-Value-Pair 列 (Error Details) であり、
 * Message Parameters とは別の型空間・処理規則を持つ (§9.4.2)。未登録の型、
 * および登録済みでも当該 Error Code に適用されない型は無視し、未知の型の重複は
 * 拒否しない。GREASE 用の予約値 (0x7f * N + 0x9D) も未登録型として同じ規則で
 * 扱う (§13 / §16.11 に REQUEST_ERROR の Error Details としての予約がある)。
 */
export const ErrorDetailType = {
  /**
   * REDIRECT (Section 9.4.2.1)
   *
   * Error Code が REDIRECT のときだけ適用され、そのときは必須。
   */
  REDIRECT: 0x01,
  /**
   * UNSUPPORTED_PROPERTY (Section 9.4.2.2)
   *
   * Error Code が UNSUPPORTED_EXTENSION のときだけ適用される。
   * 同じ型を複数回載せられる。
   */
  UNSUPPORTED_PROPERTY: 0x02,
} as const;

export type ErrorDetailType = (typeof ErrorDetailType)[keyof typeof ErrorDetailType];

/**
 * Error Details の KVP 1 件分
 *
 * draft-ietf-moq-transport-23 §8.3 / §9.4.2:
 * 奇数 Type は Length + Value、偶数 Type は vi64 の Value を持つ。
 * REDIRECT (0x01) は奇数 Type、UNSUPPORTED_PROPERTY (0x02) は偶数 Type。
 */
type RequestErrorDetail =
  | { type: typeof ErrorDetailType.REDIRECT; redirect: Redirect }
  | { type: typeof ErrorDetailType.UNSUPPORTED_PROPERTY; propertyType: bigint };

/**
 * REQUEST_ERROR メッセージ (Section 9.4.1)
 *
 * draft-ietf-moq-transport-23 Section 9.4.1 (REQUEST_ERROR Message Format):
 *
 * REQUEST_ERROR Message {
 *   Type (vi64) = 0x5,
 *   Length (vi64),
 *   Error Code (vi64),
 *   Retry Interval (vi64),
 *   Error Reason (Reason Phrase),
 *   Error Details (..) ...,
 * }
 *
 * - Error Details: §8.3 の Key-Value-Pair 列で、Message Length まで続く (§9.4.2)。
 *   既知の Detail は Error Code に適用されるときだけ解釈する。未知の Detail と
 *   適用外の既知 Detail は無視する。
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
  /**
   * REDIRECT Error Detail
   *
   * draft-ietf-moq-transport-23 §9.4.2.1: Error Code が REDIRECT のときだけ存在し、
   * そのときは必須である (欠落は MALFORMED_MESSAGE)。
   */
  redirect?: Redirect;
  /**
   * UNSUPPORTED_PROPERTY Error Detail の Value (Mandatory Track Property の Type)
   *
   * draft-ietf-moq-transport-23 §9.4.2.2: Error Code が UNSUPPORTED_EXTENSION の
   * ときだけ存在する。同じ型の Detail を複数載せられるため、順序を保った配列で
   * 保持する。適用外の Error Code では無視する。
   */
  unsupportedPropertyTypes?: readonly bigint[];
}

/**
 * Goaway のペイロードをエンコード
 *
 * draft-ietf-moq-transport-23 Section 9.2:
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
 * draft-ietf-moq-transport-23 §9.2:
 * New Session URI Length + New Session URI + Timeout
 * Timeout 消費後に余剰バイトがあれば MALFORMED_MESSAGE
 */
export function decodeGoawayPayload(data: Uint8Array, offset = 0): Goaway {
  const [uriLength, uriLengthSize] = decodeVarint(data, offset);
  offset += uriLengthSize;

  // draft-ietf-moq-transport-23 §9.2:
  // "The maximum length of the New Session URI is 8,192 bytes.
  //  If an endpoint receives a length exceeding the maximum, it MUST close the
  //  session with FIELD_LENGTH_EXCEEDED."
  if (Number(uriLength) > 8192) {
    throw new ProtocolViolationError(
      `GOAWAY URI length exceeds maximum: ${uriLength} > 8192`,
      SessionErrorCode.FIELD_LENGTH_EXCEEDED,
    );
  }

  assertLengthWithinData("GOAWAY URI", uriLength, offset, data.length);
  const uriBytes = data.slice(offset, offset + Number(uriLength));
  const newSessionUri = new TextDecoder().decode(uriBytes);
  offset += Number(uriLength);

  const [timeout, timeoutSize] = decodeVarint(data, offset);
  offset += timeoutSize;

  // draft-ietf-moq-transport-23 §9:
  // "If the length does not match the length of the Message Body,
  //  the receiver MUST close the session with MALFORMED_MESSAGE."
  // Timeout は GOAWAY ペイロードの最後のフィールドであり、
  // その後ろに後続データがあると消費バイト数が Message Body 長と一致しないため違反となる
  if (offset !== data.length) {
    throw new ProtocolViolationError(
      `trailing data after Timeout in GOAWAY: expected ${data.length} bytes, consumed ${offset}`,
      SessionErrorCode.MALFORMED_MESSAGE,
    );
  }

  return {
    type: MessageType.GOAWAY,
    newSessionUri,
    timeout,
  };
}

/**
 * PUBLISH_STATE_NOTIFY メッセージ (Section 9.10)
 *
 * draft-ietf-moq-transport-23 Section 9.10 (PUBLISH_STATE_NOTIFY):
 *
 * PUBLISH_STATE_NOTIFY Message {
 *   Type (vi64) = 0x22,
 *   Length (vi64),
 *   Number of Parameters (vi64),
 *   Parameters (..),
 * }
 *
 * publisher が subscription の bidi ストリーム上で送る片方向の状態通知。
 * 受信側は REQUEST_OK / REQUEST_ERROR を応答しない。
 */
export interface PublishStateNotify {
  type: typeof MessageType.PUBLISH_STATE_NOTIFY;
  parameters: Parameter[];
}

/**
 * PUBLISH_STATE_NOTIFY のペイロードをエンコードする
 *
 * draft-ietf-moq-transport-23 Section 9.10:
 * Number of Parameters + Parameters (delta encoding の Parameters 列)。
 */
export function encodePublishStateNotifyPayload(msg: PublishStateNotify): Uint8Array {
  return encodeParameters(msg.parameters);
}

/**
 * PUBLISH_STATE_NOTIFY のペイロードをデコードする
 *
 * draft-ietf-moq-transport-23 §9.10 / §9:
 * 消費バイト数が Message Body 長と一致しない場合は MALFORMED_MESSAGE
 * ("If the length does not match the length of the Message Body, the
 *  receiver MUST close the session with MALFORMED_MESSAGE.")。
 */
export function decodePublishStateNotifyPayload(data: Uint8Array, offset = 0): PublishStateNotify {
  const [parameters, consumed] = decodeParameters(data, offset);
  if (offset + consumed !== data.length) {
    throw new ProtocolViolationError(
      `trailing data in PUBLISH_STATE_NOTIFY: expected ${data.length} bytes, consumed ${offset + consumed}`,
      SessionErrorCode.MALFORMED_MESSAGE,
    );
  }
  return {
    type: MessageType.PUBLISH_STATE_NOTIFY,
    parameters,
  };
}

/**
 * RequestOk のペイロードをエンコード
 *
 * draft-ietf-moq-transport-23 Section 9.3:
 * Number of Parameters + Parameters
 * draft-ietf-moq-transport-23 Section 6.4.2.1
 *
 * 以下の REQUEST_OK 送信経路で使用する:
 * - 受信 PUBLISH 受理時 (SessionImpl.handleIncomingBidirectionalStream)
 * - 受信 PUBLISH ストリーム上での REQUEST_UPDATE 応答 (bidiSendRequestOk 経由、bidiHandlePublishRequestUpdate)
 * - 送信 PUBLISH の bidi ストリーム上での REQUEST_UPDATE 応答 (publisher 存在時。bidiReadRequestStreamMessages 内で直接エンコード)
 * PBT（Property-Based Testing）でのラウンドトリップテストでも使用。
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
 * draft-ietf-moq-transport-23 Section 9.3:
 * Number of Parameters + Parameters + Track Properties
 * - Track Properties は残りバイトすべて
 */
export function decodeRequestOkPayload(
  data: Uint8Array,
  offset = 0,
  propertyScope?: "track" | "object",
): RequestOk {
  const [parameters, paramsConsumed] = decodeParameters(data, offset);
  offset += paramsConsumed;

  const propertiesData = data.slice(offset);
  // draft-ietf-moq-transport-23 §8.4: Track Properties を運ぶ応答のうち、
  // 非空が正当な FETCH_OK / TRACK_STATUS_OK は scope を渡して scope 違反と
  // 重複を malformed track とする。空必須の応答 (PUBLISH_OK / REQUEST_UPDATE_OK
  // など) は scope を渡さず、§9.3 の INVALID_FIELD による Session 終了を優先する。
  const trackProperties = decodeProperties(propertiesData, propertyScope);

  return {
    type: MessageType.REQUEST_OK,
    parameters,
    trackProperties,
  };
}

// ============================================================================
// Error Details (Section 9.4.2)
// ============================================================================

/**
 * Error Detail の Value 長の最大値 (2^16-1)
 *
 * draft-ietf-moq-transport-23 §8.3 (Key-Value-Pair Structure):
 * "The maximum length of a value is 2^16-1 bytes. If an endpoint receives a
 *  length larger than the maximum, it MUST close the session with
 *  FIELD_LENGTH_EXCEEDED."
 */
const MAX_ERROR_DETAIL_VALUE_LENGTH = 65535n;

/**
 * Error Details を §8.3 の Key-Value-Pair 列としてエンコードする
 *
 * draft-ietf-moq-transport-23 §9.4.2:
 * Error Details は Key-Value-Pairs (Figure 4) として Message Length まで続く。
 * Type は前の Type からの delta でエンコードするため、Type の昇順に並べてから
 * エンコードする (§8.3)。
 *
 * @param details - エンコードする Error Detail の列 (Type の重複は呼び出し側が防ぐ)
 */
function encodeErrorDetails(details: readonly RequestErrorDetail[]): Uint8Array {
  const sortedDetails = [...details].sort((left, right) => left.type - right.type);
  const parts: Uint8Array[] = [];
  let previousType = 0n;

  for (const detail of sortedDetails) {
    const type = BigInt(detail.type);
    parts.push(encodeVarint(type - previousType));
    if (detail.type === ErrorDetailType.REDIRECT) {
      // REDIRECT (0x01) は奇数 Type のため Length + Value 形式 (§8.3 / §9.4.2.1)
      const value = encodeRedirect(detail.redirect);
      if (BigInt(value.length) > MAX_ERROR_DETAIL_VALUE_LENGTH) {
        throw new Error(
          `REDIRECT Error Detail value length ${value.length} exceeds maximum ${MAX_ERROR_DETAIL_VALUE_LENGTH}`,
        );
      }
      parts.push(encodeVarint(BigInt(value.length)));
      parts.push(value);
    } else {
      // UNSUPPORTED_PROPERTY (0x02) は偶数 Type のため vi64 の Value 形式 (§8.3 / §9.4.2.2)
      parts.push(encodeVarint(detail.propertyType));
    }
    previousType = type;
  }

  const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

/**
 * REDIRECT Error Detail の Value をデコードする
 *
 * draft-ietf-moq-transport-23 §8.3:
 * "If a receiver understands a Type, and the following Value or Length/Value
 *  does not match the serialization defined by that Type, the receiver MUST
 *  close the session with MALFORMED_KEY_VALUE."
 * Error Detail の Length で切り出した Value の中で Redirect 構造が完結しない
 * 場合と、構造の後に余剰バイトが残る場合は、当該 Type の serialization 不一致
 * として MALFORMED_KEY_VALUE でセッションを閉じる。
 *
 * @param value - Error Detail の Length で切り出した Value
 */
function decodeRedirectErrorDetail(value: Uint8Array): Redirect {
  let redirect: Redirect;
  let consumed: number;
  try {
    [redirect, consumed] = decodeRedirect(value, 0);
  } catch (error) {
    // 値の不足は、Message Length で区切られた Value 内での serialization 不一致
    // であるため MALFORMED_KEY_VALUE として扱う (§8.3)。
    if (
      error instanceof IncompleteDataError ||
      (error instanceof ProtocolViolationError && error.code === SessionErrorCode.MALFORMED_MESSAGE)
    ) {
      throw new ProtocolViolationError(
        `REDIRECT Error Detail does not match its serialization: ${error.message}`,
        SessionErrorCode.MALFORMED_KEY_VALUE,
      );
    }
    throw error;
  }
  if (consumed !== value.length) {
    throw new ProtocolViolationError(
      `REDIRECT Error Detail has trailing data: declared ${value.length} bytes, consumed ${consumed}`,
      SessionErrorCode.MALFORMED_KEY_VALUE,
    );
  }
  return redirect;
}

/**
 * Error Details を §8.3 の Key-Value-Pair 列としてデコードする
 *
 * draft-ietf-moq-transport-23 §9.4.2:
 * - 未知の Error Detail 型は無視し、既知型の重複の可否は型の定義に従う。
 *   未知型の重複は拒否しない。
 * - 既知でも当該 Error Code に適用されない Detail は無視する。
 * - REDIRECT は Error Code が REDIRECT のときだけ復号し、重複は MALFORMED_MESSAGE
 *   とする (定義が複数出現を許さない)。
 *
 * @param data - REQUEST_ERROR のペイロード
 * @param offset - Error Details の先頭オフセット
 * @param errorCode - REQUEST_ERROR の Error Code
 * @returns [REDIRECT Error Detail, UNSUPPORTED_PROPERTY Error Detail の Value 列]
 */
function decodeErrorDetails(
  data: Uint8Array,
  offset: number,
  errorCode: bigint,
): [Redirect | undefined, bigint[]] {
  let redirect: Redirect | undefined;
  const unsupportedPropertyTypes: bigint[] = [];
  let previousType = 0n;

  while (offset < data.length) {
    const [deltaType, deltaTypeSize] = decodeVarint(data, offset);
    offset += deltaTypeSize;

    const detailType = previousType + deltaType;
    // draft-ietf-moq-transport-23 §8.3:
    // "The previous Type value plus the Delta Type MUST NOT be greater than
    //  2^64 - 1. If a Delta Type is received that would be too large, the
    //  Session MUST be closed with DELTA_ENCODING_OVERFLOW."
    if (detailType > MAX_VARINT) {
      throw new ProtocolViolationError(
        `error detail type delta addition exceeds maximum: ${detailType} > ${MAX_VARINT}`,
        SessionErrorCode.DELTA_ENCODING_OVERFLOW,
      );
    }
    previousType = detailType;

    if (detailType % 2n === 0n) {
      // 偶数 Type: Value は vi64 (§8.3)。UNSUPPORTED_PROPERTY (0x02) が該当する。
      const [value, valueSize] = decodeVarint(data, offset);
      offset += valueSize;
      if (
        detailType === BigInt(ErrorDetailType.UNSUPPORTED_PROPERTY) &&
        errorCode === BigInt(RequestErrorCode.UNSUPPORTED_EXTENSION)
      ) {
        // draft-ietf-moq-transport-23 §9.4.2.2: 同じ型を複数回載せられる
        unsupportedPropertyTypes.push(value);
      }
      continue;
    }

    // 奇数 Type: Length + Value (§8.3)
    const [valueLength, valueLengthSize] = decodeVarint(data, offset);
    offset += valueLengthSize;
    if (valueLength > MAX_ERROR_DETAIL_VALUE_LENGTH) {
      throw new ProtocolViolationError(
        `error detail value length exceeds maximum: ${valueLength} > ${MAX_ERROR_DETAIL_VALUE_LENGTH}`,
        SessionErrorCode.FIELD_LENGTH_EXCEEDED,
      );
    }
    assertLengthWithinData("error detail value", valueLength, offset, data.length);
    const value = data.slice(offset, offset + Number(valueLength));
    offset += Number(valueLength);

    if (detailType !== BigInt(ErrorDetailType.REDIRECT)) {
      // 未知の Error Detail は無視する (§9.4.2)。GREASE 値も未登録型として同じ扱い。
      continue;
    }
    if (errorCode !== BigInt(RequestErrorCode.REDIRECT)) {
      // 既知でも当該 Error Code に適用されない Detail は無視する (§9.4.2)
      continue;
    }
    if (redirect !== undefined) {
      throw new ProtocolViolationError(
        "duplicate REDIRECT Error Detail in REQUEST_ERROR",
        SessionErrorCode.MALFORMED_MESSAGE,
      );
    }
    redirect = decodeRedirectErrorDetail(value);
  }

  return [redirect, unsupportedPropertyTypes];
}

/**
 * RequestError のペイロードをエンコード
 *
 * draft-ietf-moq-transport-23 Section 9.4.1:
 * Error Code + Retry Interval + Error Reason + Error Details (KVP 列)
 *
 * - Error Details は §8.3 の Key-Value-Pair 列であり、Message Parameters とは
 *   別の型空間・処理規則を持つ (§9.4.2)。REDIRECT は Error Code が REDIRECT の
 *   ときだけ、UNSUPPORTED_PROPERTY は UNSUPPORTED_EXTENSION のときだけ載せる。
 * - Error Details は Message Length まで続くため、末尾に追加の長さフィールドは無い。
 *
 * 以下の REQUEST_ERROR 送信経路で使用する:
 * - 受信リクエストの拒否 (incomingSendRequestErrorAndClose)
 * - 受信 PUBLISH ストリーム上での REQUEST_UPDATE エラー応答 (bidiSendRequestError 経由、
 *   bidiHandlePublishRequestUpdate。GOING_AWAY / NOT_SUPPORTED)
 * - 送信 PUBLISH の bidi ストリーム上での REQUEST_UPDATE エラー応答 (bidiReadRequestStreamMessages 内。
 *   bidiSendRequestError 経由で GOING_AWAY / INVALID_FILTER、直接エンコードで INTERNAL_ERROR (publisher 不在時))
 * - 受信 PUBLISH の未対応 Mandatory Track Property による拒否
 *   (UNSUPPORTED_PROPERTY Error Detail 付き)
 * PBT（Property-Based Testing）でのラウンドトリップテストでも使用。
 */
export function encodeRequestErrorPayload(msg: RequestError): Uint8Array {
  const encoder = new TextEncoder();
  const reasonBytes = encoder.encode(msg.reasonPhrase);
  const errorCode = Number(msg.errorCode);

  // draft-ietf-moq-transport-23 §9.4.2 / §9.4.2.1 / §9.4.2.2:
  // 各 Error Detail は特定の Error Code にだけ適用される。受信側は適用外の
  // 既知 Detail を無視するが、送信側が適用外の Detail を生成してよいことには
  // なっていないため、ローカル API の誤用として送信前に拒否する
  // (理由文字列ではなく Error Code で判定する)。
  const redirect = msg.redirect;
  const unsupportedPropertyTypes = msg.unsupportedPropertyTypes ?? [];
  if (redirect !== undefined && errorCode !== RequestErrorCode.REDIRECT) {
    throw new Error(
      `unexpected REDIRECT Error Detail in REQUEST_ERROR with error code 0x${errorCode.toString(16)}, expected REDIRECT (0x34)`,
    );
  }
  if (redirect === undefined && errorCode === RequestErrorCode.REDIRECT) {
    throw new Error(
      "missing REDIRECT Error Detail in REQUEST_ERROR with error code REDIRECT (0x34)",
    );
  }
  if (unsupportedPropertyTypes.length > 0 && errorCode !== RequestErrorCode.UNSUPPORTED_EXTENSION) {
    throw new Error(
      `unexpected UNSUPPORTED_PROPERTY Error Detail in REQUEST_ERROR with error code 0x${errorCode.toString(16)}, expected UNSUPPORTED_EXTENSION (0x33)`,
    );
  }

  const details: RequestErrorDetail[] = [];
  if (redirect !== undefined) {
    details.push({ type: ErrorDetailType.REDIRECT, redirect });
  }
  for (const propertyType of unsupportedPropertyTypes) {
    details.push({ type: ErrorDetailType.UNSUPPORTED_PROPERTY, propertyType });
  }

  const parts: Uint8Array[] = [];
  parts.push(encodeVarint(msg.errorCode));
  parts.push(encodeVarint(msg.retryInterval));
  parts.push(encodeVarint(reasonBytes.length));
  parts.push(reasonBytes);
  parts.push(encodeErrorDetails(details));

  const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
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
 * draft-ietf-moq-transport-23 Section 9.4.1:
 * Error Code + Retry Interval + Error Reason + Error Details (KVP 列)
 *
 * - Error Reason の後、Message Length までを §8.3 の Key-Value-Pair 列として読む
 * - 未知の Detail と適用外の既知 Detail は無視する (§9.4.2)
 * - Error Code が REDIRECT (0x34) なのに REDIRECT Error Detail が無い場合と、
 *   REDIRECT Error Detail が重複する場合は MALFORMED_MESSAGE
 */
export function decodeRequestErrorPayload(data: Uint8Array, offset = 0): RequestError {
  const [errorCode, errorCodeSize] = decodeVarint(data, offset);
  offset += errorCodeSize;

  const [retryInterval, retryIntervalSize] = decodeVarint(data, offset);
  offset += retryIntervalSize;

  const [reasonLen, reasonLenSize] = decodeVarint(data, offset);
  offset += reasonLenSize;

  // draft-ietf-moq-transport-23 §8.5:
  // Reason Phrase の最大長は 1,024 バイト。
  // "If an endpoint receives a length exceeding the maximum, it MUST close
  //  the session with FIELD_LENGTH_EXCEEDED."
  if (Number(reasonLen) > MAX_REASON_PHRASE_LENGTH) {
    throw new ProtocolViolationError(
      `reason phrase length exceeds maximum: ${reasonLen} > ${MAX_REASON_PHRASE_LENGTH}`,
      SessionErrorCode.FIELD_LENGTH_EXCEEDED,
    );
  }

  assertLengthWithinData("reason phrase", reasonLen, offset, data.length);
  const decoder = new TextDecoder();
  const reasonPhrase = decoder.decode(data.slice(offset, offset + Number(reasonLen)));
  offset += Number(reasonLen);

  const [redirect, unsupportedPropertyTypes] = decodeErrorDetails(data, offset, errorCode);

  if (redirect === undefined && errorCode === BigInt(RequestErrorCode.REDIRECT)) {
    // draft-ietf-moq-transport-23 §9.4.2.1:
    // "It accompanies Error Code REDIRECT and MUST be present when the Error
    //  Code is REDIRECT. An endpoint that receives a REQUEST_ERROR with Error
    //  Code REDIRECT and no REDIRECT Error Detail MUST close the session with
    //  MALFORMED_MESSAGE."
    throw new ProtocolViolationError(
      "missing REDIRECT Error Detail in REQUEST_ERROR with error code REDIRECT (0x34)",
      SessionErrorCode.MALFORMED_MESSAGE,
    );
  }

  // exactOptionalPropertyTypes では optional なフィールドに undefined を渡せないため、
  // 値がある場合だけ載せる
  return {
    type: MessageType.REQUEST_ERROR,
    errorCode,
    retryInterval,
    reasonPhrase,
    ...(redirect !== undefined ? { redirect } : {}),
    ...(unsupportedPropertyTypes.length > 0 ? { unsupportedPropertyTypes } : {}),
  };
}
