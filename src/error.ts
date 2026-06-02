/**
 * MOQT Error Codes
 * draft-ietf-moq-transport-18 Section 15.10 (Error Codes)
 * https://www.ietf.org/archive/id/draft-ietf-moq-transport-18.html#section-15.10
 */

/**
 * Session Termination Error Codes (Section 3.5 Termination)
 *
 * draft-ietf-moq-transport-18 Section 3.5 (Termination)
 */
export const SessionErrorCode = {
  NO_ERROR: 0x0,
  INTERNAL_ERROR: 0x1,
  UNAUTHORIZED: 0x2,
  PROTOCOL_VIOLATION: 0x3,
  INVALID_REQUEST_ID: 0x4,
  DUPLICATE_TRACK_ALIAS: 0x5,
  KEY_VALUE_FORMATTING_ERROR: 0x6,
  INVALID_PATH: 0x8,
  MALFORMED_PATH: 0x9,
  GOAWAY_TIMEOUT: 0x10,
  CONTROL_MESSAGE_TIMEOUT: 0x11,
  DATA_STREAM_TIMEOUT: 0x12,
  AUTH_TOKEN_CACHE_OVERFLOW: 0x13,
  DUPLICATE_AUTH_TOKEN_ALIAS: 0x14,
  VERSION_NEGOTIATION_FAILED: 0x15,
  MALFORMED_AUTH_TOKEN: 0x16,
  UNKNOWN_AUTH_TOKEN_ALIAS: 0x17,
  EXPIRED_AUTH_TOKEN: 0x18,
  INVALID_AUTHORITY: 0x19,
  MALFORMED_AUTHORITY: 0x1a,
} as const;

export type SessionErrorCode = (typeof SessionErrorCode)[keyof typeof SessionErrorCode];

/**
 * REQUEST_ERROR Codes (Section 10.6 REQUEST_ERROR)
 *
 * draft-ietf-moq-transport-18:
 * - GOING_AWAY (0x6) を追加 (#1434)
 * - EXCESSIVE_LOAD (0x9) を追加 (#1479)
 * - DUPLICATE_SUBSCRIPTION を 0x19 に変更
 * - NAMESPACE_TOO_LARGE (0x31) を追加 (#1496)
 * - UNKNOWN_STATUS_IN_RANGE を削除
 */
export const RequestErrorCode = {
  INTERNAL_ERROR: 0x0,
  UNAUTHORIZED: 0x1,
  TIMEOUT: 0x2,
  NOT_SUPPORTED: 0x3,
  MALFORMED_AUTH_TOKEN: 0x4,
  EXPIRED_AUTH_TOKEN: 0x5,
  GOING_AWAY: 0x6,
  EXCESSIVE_LOAD: 0x9,
  DOES_NOT_EXIST: 0x10,
  INVALID_RANGE: 0x11,
  MALFORMED_TRACK: 0x12,
  DUPLICATE_SUBSCRIPTION: 0x19,
  UNINTERESTED: 0x20,
  PREFIX_OVERLAP: 0x30,
  NAMESPACE_TOO_LARGE: 0x31,
  INVALID_JOINING_REQUEST_ID: 0x32,
  UNSUPPORTED_EXTENSION: 0x33,
  REDIRECT: 0x34,
} as const;

export type RequestErrorCode = (typeof RequestErrorCode)[keyof typeof RequestErrorCode];

/**
 * draft-ietf-moq-transport-18 §14 (Grease):
 * 未知のエラーコードは INTERNAL_ERROR として扱う。
 * Receipt of an unknown error code MUST be treated as equivalent to
 * INTERNAL_ERROR for that context.
 */
export function normalizeRequestErrorCode(code: number): RequestErrorCode {
  if (Object.values(RequestErrorCode).includes(code as RequestErrorCode)) {
    return code as RequestErrorCode;
  }
  return RequestErrorCode.INTERNAL_ERROR;
}

/**
 * draft-ietf-moq-transport-18 §14 (Grease):
 * 未知の PUBLISH_DONE コードは INTERNAL_ERROR として扱う。
 */
export function normalizePublishDoneCode(code: number): PublishDoneCode {
  if (Object.values(PublishDoneCode).includes(code as PublishDoneCode)) {
    return code as PublishDoneCode;
  }
  return PublishDoneCode.INTERNAL_ERROR;
}

/**
 * PUBLISH_DONE Codes (Section 10.11 PUBLISH_DONE)
 *
 * draft-ietf-moq-transport-18:
 * - MALFORMED_TRACK を 0x12 に変更
 * - EXCESSIVE_LOAD (0x9) を追加 (#1479)
 */
export const PublishDoneCode = {
  INTERNAL_ERROR: 0x0,
  UNAUTHORIZED: 0x1,
  TRACK_ENDED: 0x2,
  SUBSCRIPTION_ENDED: 0x3,
  GOING_AWAY: 0x4,
  TOO_FAR_BEHIND: 0x5,
  EXPIRED: 0x6,
  UPDATE_FAILED: 0x8,
  EXCESSIVE_LOAD: 0x9,
  MALFORMED_TRACK: 0x12,
} as const;

export type PublishDoneCode = (typeof PublishDoneCode)[keyof typeof PublishDoneCode];

/**
 * Stream Reset Error Codes (Section 15.10.4)
 *
 * draft-ietf-moq-transport-18 Section 15.10.4 (Stream Reset Error Codes):
 * - GOING_AWAY (0x4) を追加
 * - UNKNOWN_OBJECT_STATUS (0x6) を追加
 * - EXPIRED_AUTH_TOKEN (0x7) を追加
 * - EXCESSIVE_LOAD (0x9) を追加
 * - MALFORMED_TRACK (0x12) を追加
 */
export const DataStreamErrorCode = {
  INTERNAL_ERROR: 0x0,
  CANCELLED: 0x1,
  DELIVERY_TIMEOUT: 0x2,
  SESSION_CLOSED: 0x3,
  GOING_AWAY: 0x4,
  TOO_FAR_BEHIND: 0x5,
  UNKNOWN_OBJECT_STATUS: 0x6,
  EXPIRED_AUTH_TOKEN: 0x7,
  EXCESSIVE_LOAD: 0x9,
  MALFORMED_TRACK: 0x12,
} as const;

export type DataStreamErrorCode = (typeof DataStreamErrorCode)[keyof typeof DataStreamErrorCode];

/**
 * MOQT Error class
 */
export class MoqtError extends Error {
  constructor(
    message: string,
    public readonly code: number,
  ) {
    super(message);
    this.name = "MoqtError";
  }
}

/**
 * Session termination error
 */
export class SessionError extends MoqtError {
  constructor(message: string, code: SessionErrorCode) {
    super(message, code);
    this.name = "SessionError";
  }
}

/**
 * Redirect 情報 (Section 10.6.1)
 *
 * draft-ietf-moq-transport-18 Section 10.6.1 (Redirect Structure):
 * サーバーがクライアントに対して別の接続先への再接続を指示する。
 * Track Namespace は tuple 形式で保持する。
 */
export interface RedirectInfo {
  connectUri: string;
  trackNamespace: Uint8Array[];
  trackName: Uint8Array;
}

/**
 * Request error (SUBSCRIBE, PUBLISH, FETCH failed)
 */
export class RequestError extends MoqtError {
  readonly retryInterval: bigint | undefined;
  readonly redirect: RedirectInfo | undefined;

  constructor(
    message: string,
    code: RequestErrorCode,
    retryInterval?: bigint,
    redirect?: RedirectInfo,
  ) {
    super(message, code);
    this.name = "RequestError";
    this.retryInterval = retryInterval;
    this.redirect = redirect;
  }
}

/**
 * decode 関数がバッファ不足を検出したときに投げるエラー
 *
 * draft-ietf-moq-transport-18 のデータストリーム / 制御メッセージ decode は、
 * バッファに必要なバイト数が揃っていない時点で例外を投げる。
 * 受信ループはこのエラーを受けて次のチャンクを待つ。
 */
export class IncompleteDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IncompleteDataError";
  }
}

/**
 * プロトコル違反 (仕様で定められた値・形式に違反した受信データ) を検出したときに投げるエラー
 *
 * draft-ietf-moq-transport-18 で MUST 要件として定められた受信データの妥当性検証
 * (ストリームヘッダーの予約値、Object Status の不正値、Properties Length の不整合等) で
 * 違反を検出した場合に投げる。受信ループはこのエラーを受けて
 * PROTOCOL_VIOLATION でセッションを閉じる。
 */
export class ProtocolViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolViolationError";
  }
}

/**
 * Malformed Track を検出したときに投げるエラー
 *
 * draft-ietf-moq-transport-18 §2.4.2 / §12.7 / §12.8 / §12.9:
 * Object 内で MUST 規定 (IMMUTABLE_PROPERTIES の再帰禁止、各 Property の Object 当たり
 * 1 つだけ等) が違反された場合、Track は malformed として扱われる。データストリーム
 * 単位で `RESET_STREAM_AT(MALFORMED_TRACK)` で打ち切る上位ハンドリングへ伝搬する。
 */
export class MalformedTrackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MalformedTrackError";
  }
}
