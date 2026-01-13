/**
 * MOQT Error Codes
 * draft-ietf-moq-transport-15 Section 13.3
 */

/**
 * Session Termination Error Codes (Section 3.4)
 */
export const SessionErrorCode = {
  NO_ERROR: 0x0,
  INTERNAL_ERROR: 0x1,
  UNAUTHORIZED: 0x2,
  PROTOCOL_VIOLATION: 0x3,
  INVALID_REQUEST_ID: 0x4,
  DUPLICATE_TRACK_ALIAS: 0x5,
  KEY_VALUE_FORMATTING_ERROR: 0x6,
  TOO_MANY_REQUESTS: 0x7,
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
 * REQUEST_ERROR Codes (Section 9.8)
 *
 * draft-ietf-moq-transport-16:
 * DUPLICATE_SUBSCRIPTION (0x31) を追加。
 * 重複サブスクリプションは Session Error ではなく Request Error として処理する。
 * https://github.com/moq-wg/moq-transport/pull/1341
 */
export const RequestErrorCode = {
  INTERNAL_ERROR: 0x0,
  UNAUTHORIZED: 0x1,
  TIMEOUT: 0x2,
  NOT_SUPPORTED: 0x3,
  MALFORMED_AUTH_TOKEN: 0x4,
  EXPIRED_AUTH_TOKEN: 0x5,
  DOES_NOT_EXIST: 0x10,
  INVALID_RANGE: 0x11,
  MALFORMED_TRACK: 0x12,
  UNINTERESTED: 0x20,
  PREFIX_OVERLAP: 0x30,
  DUPLICATE_SUBSCRIPTION: 0x31,
  INVALID_JOINING_REQUEST_ID: 0x32,
  UNKNOWN_STATUS_IN_RANGE: 0x33,
} as const;

export type RequestErrorCode = (typeof RequestErrorCode)[keyof typeof RequestErrorCode];

/**
 * PUBLISH_DONE Codes (Section 9.15)
 */
export const PublishDoneCode = {
  INTERNAL_ERROR: 0x0,
  UNAUTHORIZED: 0x1,
  TRACK_ENDED: 0x2,
  SUBSCRIPTION_ENDED: 0x3,
  GOING_AWAY: 0x4,
  EXPIRED: 0x5,
  TOO_FAR_BEHIND: 0x6,
  MALFORMED_TRACK: 0x7,
  UPDATE_FAILED: 0x8,
} as const;

export type PublishDoneCode = (typeof PublishDoneCode)[keyof typeof PublishDoneCode];

/**
 * Data Stream Reset Error Codes (Section 10.4.3)
 */
export const DataStreamErrorCode = {
  INTERNAL_ERROR: 0x0,
  CANCELLED: 0x1,
  DELIVERY_TIMEOUT: 0x2,
  SESSION_CLOSED: 0x3,
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
 * Request error (SUBSCRIBE, PUBLISH, FETCH failed)
 */
export class RequestError extends MoqtError {
  constructor(message: string, code: RequestErrorCode) {
    super(message, code);
    this.name = "RequestError";
  }
}
