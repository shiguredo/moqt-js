/**
 * MOQT Error Codes
 * draft-ietf-moq-transport-20 Section 15.11 (Error Codes)
 * https://www.ietf.org/archive/id/draft-ietf-moq-transport-20.html#section-15.11
 */

import { PublishDoneStatusCode } from "./message/types";

// PublishDoneStatusCode を再公開（error.ts の利用者が import しやすいように）
export { PublishDoneStatusCode };

/**
 * Session Termination Error Codes (Section 3.5 Termination)
 *
 * draft-ietf-moq-transport-20 Section 3.5 (Termination)
 *
 * draft-ietf-moq-transport-20 Appendix A.1 で 0x15
 * VERSION_NEGOTIATION_FAILED は削除された。
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
  MALFORMED_AUTH_TOKEN: 0x16,
  UNKNOWN_AUTH_TOKEN_ALIAS: 0x17,
  EXPIRED_AUTH_TOKEN: 0x18,
  INVALID_AUTHORITY: 0x19,
  MALFORMED_AUTHORITY: 0x1a,
  /**
   * TOO_MANY_REQUEST_UPDATES (Section 3.5)
   *
   * draft-ietf-moq-transport-20:
   * MAX_REQUEST_UPDATES で広告した上限を超える REQUEST_UPDATE を受信した。
   */
  TOO_MANY_REQUEST_UPDATES: 0x1b,
} as const;

export type SessionErrorCode = (typeof SessionErrorCode)[keyof typeof SessionErrorCode];

/**
 * REQUEST_ERROR Codes (Section 10.6 REQUEST_ERROR)
 *
 * draft-ietf-moq-transport-20:
 * - GOING_AWAY (0x6) を追加
 * - EXCESSIVE_LOAD (0x9) を追加
 * - DUPLICATE_SUBSCRIPTION を削除（draft-20 §5.1 で同一 Track への複数サブスクリプションが許可）
 * - NAMESPACE_TOO_LARGE (0x31) を追加
 * - INVALID_JOINING_REQUEST_ID (0x32) を削除 (draft-20 で Joining FETCH 削除)
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
  UNINTERESTED: 0x20,
  PREFIX_OVERLAP: 0x30,
  NAMESPACE_TOO_LARGE: 0x31,
  UNSUPPORTED_EXTENSION: 0x33,
  REDIRECT: 0x34,
  /**
   * CONFLICTING_FILTERS (Section 10.6)
   * draft-ietf-moq-transport-20: SUBSCRIBE_TRACKS 応答専用
   */
  CONFLICTING_FILTERS: 0x35,
  /**
   * INVALID_FILTER (Section 10.6)
   * draft-ietf-moq-transport-20: フィルタ不正・上限超過
   */
  INVALID_FILTER: 0x36,
} as const;

export type RequestErrorCode = (typeof RequestErrorCode)[keyof typeof RequestErrorCode];

/**
 * draft-ietf-moq-transport-20 §14 (Grease):
 * 未知のエラーコードは INTERNAL_ERROR として扱う。
 * Receipt of an unknown error code MUST be treated as equivalent to
 * INTERNAL_ERROR for that context.
 */
const REQUEST_ERROR_CODE_SET = new Set(Object.values(RequestErrorCode));

export function normalizeRequestErrorCode(code: number): RequestErrorCode {
  if (REQUEST_ERROR_CODE_SET.has(code as RequestErrorCode)) {
    return code as RequestErrorCode;
  }
  return RequestErrorCode.INTERNAL_ERROR;
}

/**
 * draft-ietf-moq-transport-20 §14 (Grease):
 * 未知の PUBLISH_DONE コードは INTERNAL_ERROR として扱う。
 * 削除された 0x3 SUBSCRIPTION_ENDED も未知扱いで正規化される。
 */
const PUBLISH_DONE_CODE_SET = new Set(Object.values(PublishDoneStatusCode));

export function normalizePublishDoneCode(code: number): PublishDoneStatusCode {
  if (PUBLISH_DONE_CODE_SET.has(code as unknown as PublishDoneStatusCode)) {
    return code as PublishDoneStatusCode;
  }
  return PublishDoneStatusCode.INTERNAL_ERROR;
}

/**
 * draft-ietf-moq-transport-20 §14 (Grease):
 * 未知の Session Termination エラーコードは INTERNAL_ERROR として扱う。
 * 削除された 0x15 VERSION_NEGOTIATION_FAILED も未知扱いで正規化される。
 */
const SESSION_ERROR_CODE_SET = new Set(Object.values(SessionErrorCode));

export function normalizeSessionErrorCode(code: number): SessionErrorCode {
  if (SESSION_ERROR_CODE_SET.has(code as unknown as SessionErrorCode)) {
    return code as SessionErrorCode;
  }
  return SessionErrorCode.INTERNAL_ERROR;
}

/**
 * Stream Reset Error Codes (Section 15.11.4)
 *
 * draft-ietf-moq-transport-20 Section 15.11.4 (Stream Reset Error Codes):
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
 * draft-ietf-moq-transport-20 §14 (Grease):
 * 未知の Data Stream Reset エラーコードは INTERNAL_ERROR として扱う。
 */
const DATA_STREAM_ERROR_CODE_SET = new Set(Object.values(DataStreamErrorCode));

export function normalizeDataStreamErrorCode(code: number): DataStreamErrorCode {
  if (DATA_STREAM_ERROR_CODE_SET.has(code as unknown as DataStreamErrorCode)) {
    return code as DataStreamErrorCode;
  }
  return DataStreamErrorCode.INTERNAL_ERROR;
}

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
 * draft-ietf-moq-transport-20 Section 10.6.1 (Redirect Structure):
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
 * draft-ietf-moq-transport-20 のデータストリーム / 制御メッセージ decode は、
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
 * draft-ietf-moq-transport-20 で MUST 要件として定められた受信データの妥当性検証
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
 * draft-ietf-moq-transport-20 §2.4.2 / §12.7 / §12.8 / §12.9:
 * Object 内で MUST 規定 (IMMUTABLE_PROPERTIES の再帰禁止、各 Property の Object 当たり
 * 1 つだけ、同一 Subgroup 内の Publisher Priority 不一致等) が違反された場合、
 * Track は malformed として扱われる。セッションは閉じず、データストリーム単位で
 * STOP_SENDING 相当 (cancelStreamQuiet) で打ち切るか、FETCH データストリームの場合は
 * 対応する FETCH をキャンセルして error コールバックで通知する上位ハンドリングへ
 * 伝搬する。
 */
export class MalformedTrackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MalformedTrackError";
  }
}

/**
 * 不正な Range Filter および Location Filter (値域・Property Type 偶数・
 * 組み合わせ重複・構造不正・End Group の 2^64-1 超過) を検出したときに投げるエラー
 *
 * draft-ietf-moq-transport-20 §5.1.2 / §5.1.4 / §10.2.12-14:
 * 受信側ではフィルタ不正は REQUEST_ERROR (INVALID_FILTER) で応答するか、応答不能な
 * 経路 (PUBLISH_OK 受信等) では PROTOCOL_VIOLATION でセッションを閉じる。
 * 送信側 (encodeRangeFilter) ではローカル API 誤用 (SetID 範囲外・奇数 Property
 * Type・PRIORITY_FILTER 255 超・Range 絶対値 2^64-1 超過・空 ranges) を
 * 送信前に検出して throw する。
 * 送信側 (encodeLocationFilter) では §5.1.2 の End Group (StartGroup +
 * EndGroupDelta) が 2^64-1 を超える 3 / 4 フィールド表現を送信前に検出して
 * throw する (本エラーの Location Filter 関連用途は送信前検証専用で、受信側の
 * デコード (decodeLocationFilter) は ProtocolViolationError を使う)。
 * 既存の ProtocolViolationError → PROTOCOL_VIOLATION 変換に自動で乗せず、
 * 経路ごとの変換を明示するために ProtocolViolationError を継承しない。
 */
export class InvalidFilterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidFilterError";
  }
}

/**
 * 閉じた Subgroup への送信を拒否するときに投げるエラー
 *
 * draft-ietf-moq-transport-20 §11.4.3 (Closing Subgroup Streams):
 * "A publisher that receives a STOP_SENDING on a Subgroup stream SHOULD NOT
 *  attempt to open a new stream to deliver additional Objects in that Subgroup."
 *
 * delivery timeout または STOP_SENDING で閉じた Subgroup への再送信を
 * Publisher が検出し上位に伝搬するために使用する。
 */
export class ClosedSubgroupError extends Error {
  constructor(
    message: string,
    readonly trackAlias: bigint,
    readonly groupId: bigint,
  ) {
    super(message);
    this.name = "ClosedSubgroupError";
  }
}
