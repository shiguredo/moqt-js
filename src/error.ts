/**
 * MOQT Error Codes
 * draft-ietf-moq-transport-23 Section 12 (Error Handling) / Section 16.12
 */

import { PublishDoneStatusCode } from "./message/types";

// PublishDoneStatusCode を再公開（error.ts の利用者が import しやすいように）
export { PublishDoneStatusCode };

/**
 * Session Termination Error Codes (Section 12.2 Session Termination Codes)
 *
 * draft-ietf-moq-transport-23 §12.2:
 * 0x200-0x2FF はデータストリーム / datagram、0x300-0x3FF は制御ストリーム /
 * 制御メッセージ、0x400-0x4FF はその両方で発生し得るエラーの範囲である。
 * 複数のコードが該当する場合は DELTA_ENCODING_OVERFLOW / FIELD_LENGTH_EXCEEDED を
 * 優先する (同節)。未知のコードの扱い (受信時は INTERNAL_ERROR 相当) は §13 の
 * まま維持する。範囲からカテゴリを推定することは認められているが、認証や回復の
 * 意味へ読み替えない。
 *
 * 0x15 VERSION_NEGOTIATION_FAILED は draft-20 で削除された (§A.4)。
 */
export const SessionErrorCode = {
  NO_ERROR: 0x0,
  INTERNAL_ERROR: 0x1,
  UNAUTHORIZED: 0x2,
  /**
   * PROTOCOL_VIOLATION (0x3)
   *
   * §12.2: "The remote endpoint performed an action that was disallowed by
   * the specification and no more specific code applies."
   * 空の Track Name (§2.4.1) や、要求の受信側が request stream 上の GOAWAY を
   * 受信した場合 (§9.2) など、仕様が明示的にこのコードを要求する違反に使う。
   */
  PROTOCOL_VIOLATION: 0x3,
  INVALID_REQUEST_ID: 0x4,
  DUPLICATE_TRACK_ALIAS: 0x5,
  /**
   * MALFORMED_KEY_VALUE (0x6)
   *
   * §8.3: 既知 Type の Key-Value-Pair (Setup Option / Property) の Value / Length が
   * Type の定義する serialization に一致しない。
   */
  MALFORMED_KEY_VALUE: 0x6,
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
   * TOO_MANY_REQUEST_UPDATES (Section 12.2)
   *
   * MAX_REQUEST_UPDATES で広告した上限を超える REQUEST_UPDATE を受信した。
   */
  TOO_MANY_REQUEST_UPDATES: 0x1b,
  /**
   * INVALID_STREAM_HEADER (0x200)
   *
   * §12.2: データストリーム / datagram の Type が未知、または Type Flags が不正。
   */
  INVALID_STREAM_HEADER: 0x200,
  /**
   * MALFORMED_OBJECT (0x201)
   *
   * §12.2: データストリーム / datagram 上の Object の serialization がデコード
   * できない。先行 Object の無い継承参照を含む。
   */
  MALFORMED_OBJECT: 0x201,
  /**
   * INVALID_OBJECT_STATUS (0x202)
   *
   * §12.2: Object Status が不正、または Status が Normal でない Object が
   * Properties を持つ。
   */
  INVALID_OBJECT_STATUS: 0x202,
  /**
   * TRUNCATED_OBJECT (0x203)
   *
   * §12.2 / §11.3: Object の途中でデータストリームが FIN した。
   */
  TRUNCATED_OBJECT: 0x203,
  /**
   * MALFORMED_MESSAGE (0x300)
   *
   * §9 / §12.2: 制御メッセージを parse できない。Message Length が Body の長さと
   * 一致しない場合を含む (必須要素の欠落も同節)。
   */
  MALFORMED_MESSAGE: 0x300,
  /**
   * INVALID_FIELD (0x301)
   *
   * §12.2: 制御メッセージは parse できたが、フィールドの値が許可されていない。
   * 例: 空でなければならないメッセージの Track Properties が非空 (§9.3)。
   */
  INVALID_FIELD: 0x301,
  /**
   * INVALID_TRACK_NAMESPACE (0x302)
   *
   * §8.7: Track Namespace が §8.7 に適合しない (Field Length 0 / 32 fields 超)。
   */
  INVALID_TRACK_NAMESPACE: 0x302,
  /**
   * UNEXPECTED_MESSAGE (0x303)
   *
   * §12.2: 未知のメッセージ型、誤った stream、誤った順序、許容回数超過のメッセージ。
   */
  UNEXPECTED_MESSAGE: 0x303,
  /**
   * ROLE_VIOLATION (0x304)
   *
   * §12.2: ピアがその役割では送信できないメッセージ / フィールドを送った。
   */
  ROLE_VIOLATION: 0x304,
  /**
   * INVALID_PARAMETER (0x305)
   *
   * §9.19: Message Parameter が未知・重複・そのメッセージで不許可・値域外。
   */
  INVALID_PARAMETER: 0x305,
  /**
   * CLOSED_CONTROL_STREAM (0x306)
   *
   * §6.3: ピアが Session の存続中に制御ストリームを閉じた。
   */
  CLOSED_CONTROL_STREAM: 0x306,
  /**
   * DELTA_ENCODING_OVERFLOW (0x400)
   *
   * §12.2: delta 符号化から復元した値が 0 未満、または 2^64-1 を超えた。
   */
  DELTA_ENCODING_OVERFLOW: 0x400,
  /**
   * FIELD_LENGTH_EXCEEDED (0x401)
   *
   * §12.2: フィールドまたは構造が許される最大長を超えた。制御メッセージの
   * Message Length が自 endpoint の MAX_CONTROL_MESSAGE_SIZE を超えた場合にも使う
   * (§9)。複数のコードが該当する場合はこのコードを優先する。
   */
  FIELD_LENGTH_EXCEEDED: 0x401,
} as const;

export type SessionErrorCode = (typeof SessionErrorCode)[keyof typeof SessionErrorCode];

/**
 * REQUEST_ERROR Codes (Section 12.3 Request Error Codes)
 *
 * 現在のコード集合に至るまでの増減は draft-23 自体の変更ではないため、変更が
 * 入ったドラフトを併記する:
 * - GOING_AWAY (0x6) / EXCESSIVE_LOAD (0x9) / NAMESPACE_TOO_LARGE (0x31) の追加は
 *   draft-17 (§A.7「Since draft-16」の変更履歴)
 * - UNKNOWN_STATUS_IN_RANGE の削除も draft-17
 * - DUPLICATE_SUBSCRIPTION の削除は draft-19 (§A.5「Allow multiple concurrent
 *   subscriptions per Track」)
 * - INVALID_JOINING_REQUEST_ID (0x32) の削除は draft-20 (Joining FETCH の削除。
 *   draft-23 §A.4「Replace Joining FETCH with fill fetch streams」に記載がある)
 */
export const RequestErrorCode = {
  INTERNAL_ERROR: 0x0,
  UNAUTHORIZED: 0x1,
  TIMEOUT: 0x2,
  NOT_SUPPORTED: 0x3,
  MALFORMED_AUTH_TOKEN: 0x4,
  EXPIRED_AUTH_TOKEN: 0x5,
  GOING_AWAY: 0x6,
  /**
   * EXCESSIVE_LOAD (Section 12.3)
   * draft-ietf-moq-transport-23: 応答側が過負荷。Retry Interval で再試行時期を示す。
   */
  EXCESSIVE_LOAD: 0x9,
  /**
   * UNAVAILABLE (Section 12.3)
   *
   * "The responder cannot fulfill this request at this time, but might be able
   *  to later; for example, a relay lacks stream credit to forward it upstream
   *  (see Section 7.4).  The sender SHOULD use the Retry Interval to indicate
   *  when the request can be retried."
   * クライアント (requester) は relay の stream credit 管理を追加せず、受信時に
   * Retry Interval をアプリへ渡すだけにする (Section 7.4)。
   */
  UNAVAILABLE: 0x0a,
  DOES_NOT_EXIST: 0x10,
  INVALID_RANGE: 0x11,
  MALFORMED_TRACK: 0x12,
  UNINTERESTED: 0x20,
  NAMESPACE_TOO_LARGE: 0x31,
  UNSUPPORTED_EXTENSION: 0x33,
  REDIRECT: 0x34,
  /**
   * CONFLICTING_FILTERS (Section 12.3)
   * draft-ietf-moq-transport-23: SUBSCRIBE_TRACKS 応答専用
   */
  CONFLICTING_FILTERS: 0x35,
  /**
   * INVALID_FILTER (Section 12.3)
   * draft-ietf-moq-transport-23: フィルタ不正・上限超過
   */
  INVALID_FILTER: 0x36,
} as const;

export type RequestErrorCode = (typeof RequestErrorCode)[keyof typeof RequestErrorCode];

/**
 * draft-ietf-moq-transport-23 §13 (Grease):
 * 未知のエラーコードは INTERNAL_ERROR として扱う。
 * Receipt of an unknown error code MUST be treated as equivalent to
 * INTERNAL_ERROR for that context.
 *
 * draft-ietf-moq-transport-23 §16.12.2 (REQUEST_ERROR Codes) に 0x17 は
 * 収載されていない。UNKNOWN_AUTH_TOKEN_ALIAS (0x17) は §16.12.1 (Session
 * Termination Error Codes) にのみ収載されるコードであり、§8.9 が未登録
 * Alias の参照に指名するコードでもある。本実装はそのコードを Session
 * Termination として送るため、受理集合は RequestErrorCode の値だけで組み立てる。
 * REQUEST_ERROR で 0x17 を受信した場合は未登録コードとして INTERNAL_ERROR に
 * 正規化される。
 */
const REQUEST_ERROR_CODE_SET = new Set(Object.values(RequestErrorCode));

export function normalizeRequestErrorCode(code: number): RequestErrorCode {
  if (REQUEST_ERROR_CODE_SET.has(code as RequestErrorCode)) {
    return code as RequestErrorCode;
  }
  return RequestErrorCode.INTERNAL_ERROR;
}

/**
 * draft-ietf-moq-transport-23 §13 (Grease):
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
 * draft-ietf-moq-transport-23 §13 (Grease):
 * 未知の Session Termination エラーコードは INTERNAL_ERROR として扱う。
 * 削除された 0x15 VERSION_NEGOTIATION_FAILED も未知扱いで正規化される。
 * §12.2 の範囲 (0x200-0x4FF) に含まれる未知コードも、範囲からカテゴリを
 * 推定して別の意味に置き換えず INTERNAL_ERROR にする (§13)。
 */
const SESSION_ERROR_CODE_SET = new Set(Object.values(SessionErrorCode));

export function normalizeSessionErrorCode(code: number): SessionErrorCode {
  if (SESSION_ERROR_CODE_SET.has(code as unknown as SessionErrorCode)) {
    return code as SessionErrorCode;
  }
  return SessionErrorCode.INTERNAL_ERROR;
}

/**
 * Stream Reset Error Codes (Section 16.12.4)
 *
 * draft-ietf-moq-transport-23 Section 12.5 (Stream Reset Error Codes):
 * - GOING_AWAY (0x4)
 * - TOO_FAR_BEHIND (0x5)
 * - EXPIRED_AUTH_TOKEN (0x7)
 * - EXCESSIVE_LOAD (0x9)
 * - MALFORMED_TRACK (0x12)
 *
 * draft-ietf-moq-transport-23 では draft-22 の UNKNOWN_OBJECT_STATUS (0x6) が
 * 削除された。受信した 0x6 は Section 13 (Grease) の未知コードとして
 * INTERNAL_ERROR に正規化する。
 */
export const DataStreamErrorCode = {
  INTERNAL_ERROR: 0x0,
  CANCELLED: 0x1,
  DELIVERY_TIMEOUT: 0x2,
  SESSION_CLOSED: 0x3,
  GOING_AWAY: 0x4,
  TOO_FAR_BEHIND: 0x5,
  EXPIRED_AUTH_TOKEN: 0x7,
  EXCESSIVE_LOAD: 0x9,
  MALFORMED_TRACK: 0x12,
} as const;

export type DataStreamErrorCode = (typeof DataStreamErrorCode)[keyof typeof DataStreamErrorCode];

/**
 * draft-ietf-moq-transport-23 §13 (Grease):
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
 * ピアの RESET_STREAM で失敗した read / write の失敗値から Data Stream Reset の error code を
 * 取り出す
 *
 * WebTransport は失敗値 (WebTransportError) の `streamErrorCode` に code を載せる。
 * draft-ietf-moq-transport-23 Section 12.5 の code に正規化し、未知の code は
 * INTERNAL_ERROR として扱う (Section 13)。数値の code を持たない失敗値からは取り出さない。
 *
 * @param rawError - read / write の失敗値
 * @returns 正規化した code。取り出せなければ undefined
 */
export function peerStreamErrorCode(rawError: unknown): DataStreamErrorCode | undefined {
  if (typeof rawError !== "object" || rawError === null) {
    return undefined;
  }
  const streamErrorCode = (rawError as { streamErrorCode?: unknown }).streamErrorCode;
  if (typeof streamErrorCode !== "number") {
    return undefined;
  }
  return normalizeDataStreamErrorCode(streamErrorCode);
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
 * Redirect 情報 (Section 9.4.2.1 REDIRECT)
 *
 * draft-ietf-moq-transport-23 Section 9.4.2.1 (REDIRECT):
 * サーバーがクライアントに対して別の接続先への再接続を指示する。
 * Track Namespace は tuple 形式で保持する。
 */
export interface RedirectInfo {
  /**
   * 新しいセッションの URI
   *
   * draft-ietf-moq-transport-23 Section 9.4.2.1: 空のときは要求側が現在のセッション URI を
   * 使う SHOULD。
   */
  connectUri: string;
  /**
   * 再試行先の Track Namespace
   *
   * track-scoped / namespace-scoped のどちらでも、この値が転送先の Namespace になる。
   */
  trackNamespace: Uint8Array[];
  /**
   * 再試行先の Track Name
   *
   * track-scoped のリクエストではこの値で置き換える。namespace-scoped のリクエストでは
   * 空でなければならない (Section 9.4.2.1 の MUST)。
   */
  trackName: Uint8Array;
}

/**
 * Request error (SUBSCRIBE, PUBLISH, FETCH failed)
 */
export class RequestError extends MoqtError {
  /**
   * 再試行までの最小時間
   *
   * draft-ietf-moq-transport-23 Section 9.4.1: 「ミリ秒 + 1」の生値であり、0 は
   * 「そのままでは再試行しない」を意味する (Section 12.3 により、0 であっても
   * Redirect の追従は妨げられない)。受信した REQUEST_ERROR ではこのフィールドは必須の
   * ため、undefined になるのはライブラリがローカルに生成したエラー (GOAWAY による
   * 保留中の更新の失敗など) だけである。
   */
  readonly retryInterval: bigint | undefined;
  /**
   * Redirect 情報
   *
   * draft-ietf-moq-transport-23 Section 9.4.2.1: Error Code が REDIRECT のときだけ存在する
   * REDIRECT Error Detail の内容。ライブラリは値の保持とアプリへの通知のみを行い、
   * 再試行や追従は自動では行わない (Section 12.3 の SHOULD は要求側が新しい
   * セッションを張って再試行することを求めるが、再試行の判断はアプリに委ねる)。
   */
  readonly redirect: RedirectInfo | undefined;
  /**
   * 未対応の Mandatory Track Property の Type 一覧
   *
   * draft-ietf-moq-transport-23 Section 9.4.2.2 (UNSUPPORTED_PROPERTY):
   * UNSUPPORTED_EXTENSION で拒否された要求では、送信者が理解できなかった
   * Mandatory Track Property の Type が UNSUPPORTED_PROPERTY Error Detail として
   * 1 つ以上載る (複数出現可)。ライブラリは受信した Detail をそのまま保持する。
   * それ以外の Error Code や、Detail を持たない REQUEST_ERROR では空配列になる
   * (Section 9.4.2 のとおり、未知の Error Detail と適用外の既知 Error Detail は
   * 無視する)。理由文字列から Type を復元することはしない。
   */
  readonly unsupportedPropertyTypes: readonly bigint[];

  constructor(
    message: string,
    code: RequestErrorCode,
    retryInterval?: bigint,
    redirect?: RedirectInfo,
    unsupportedPropertyTypes: readonly bigint[] = [],
  ) {
    super(message, code);
    this.name = "RequestError";
    this.retryInterval = retryInterval;
    this.redirect = redirect;
    this.unsupportedPropertyTypes = unsupportedPropertyTypes;
  }
}

/**
 * decode 関数がバッファ不足を検出したときに投げるエラー
 *
 * draft-ietf-moq-transport-23 のデータストリーム / 制御メッセージ decode は、
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
 * draft-ietf-moq-transport-23 §12.2:
 * 受信データの妥当性検証 (ストリームヘッダーの予約値、Object Status の不正値、
 * Properties Length の不整合等) で MUST 要件の違反を検出した場合に投げる。受信ループは
 * このエラーを SessionError へ変換し、セッションを閉じる。
 *
 * code には、違反に対応する §12.2 のコードを指定する。仕様が特定のコードを
 * 要求している違反 (例: データストリームの Type Flags は INVALID_STREAM_HEADER、
 * Object の delta 復元結果の上限超過は DELTA_ENCODING_OVERFLOW) ではそのコードを、
 * 「他に specific なコードが当てはまらない」違反 (例: §2.4.1 の空 Track Name、
 * §9.2 の要求受信側での request stream 上の GOAWAY) では既定の PROTOCOL_VIOLATION を
 * 指定する。文字列置換で一括変換せず、経路ごとに仕様根拠を確認して指定すること。
 */
export class ProtocolViolationError extends Error {
  constructor(
    message: string,
    public readonly code: SessionErrorCode = SessionErrorCode.PROTOCOL_VIOLATION,
  ) {
    super(message);
    this.name = "ProtocolViolationError";
  }
}

/**
 * Malformed Track を検出したときに投げるエラー
 *
 * draft-ietf-moq-transport-23 §12.1 / §10.7 / §10.8 / §10.9:
 * Object 内で MUST 規定 (IMMUTABLE_PROPERTIES の再帰禁止、各 Property の Object 当たり
 * 1 つだけ、同一 Subgroup 内の Publisher Priority 不一致等) が違反された場合、
 * Track は malformed として扱われる。セッションは閉じず、データストリーム単位で
 * STOP_SENDING 相当 (cancelStreamQuiet) で打ち切るか、FETCH データストリームの場合は
 * 対応する FETCH をキャンセルして error コールバックで通知する上位ハンドリングへ
 * 伝搬する。
 *
 * 未知の Mandatory Track Property を含む Track Properties を検出した場合も
 * malformed として扱い、その Type 一覧を unsupportedPropertyTypes に載せる。
 * 受信 PUBLISH の拒否では、この一覧を REQUEST_ERROR の UNSUPPORTED_PROPERTY
 * Error Detail に載せる (§3.7 / §9.4.2.2)。呼び出し側が理由文字列から Type を
 * 復元することはしない。
 */
export class MalformedTrackError extends Error {
  /**
   * 未知の Mandatory Track Property の Type 一覧
   *
   * draft-ietf-moq-transport-23 §3.7 (Mandatory to Understand Track Properties):
   * 受信側が理解できない Mandatory Track Property (0x4000-0x7FFF) の Type を、
   * 検出順に重複を除かず保持する。Track Properties の decodeProperties 系は
   * 1 件目で打ち切らず構造全体を検証してから本エラーを投げるため、複数件が載り得る。
   * 未知 Mandatory Track Property 以外の理由で malformed と判定した場合は空配列。
   */
  readonly unsupportedPropertyTypes: readonly bigint[];

  constructor(message: string, unsupportedPropertyTypes: readonly bigint[] = []) {
    super(message);
    this.name = "MalformedTrackError";
    this.unsupportedPropertyTypes = unsupportedPropertyTypes;
  }
}

/**
 * 不正な Range Filter および Location Filter (値域・Property Type 偶数・
 * 組み合わせ重複・構造不正・End Group の 2^64-1 超過) を検出したときに投げるエラー
 *
 * draft-ietf-moq-transport-23 §3.3.1 / §3.3.2 / §9.19.10-13:
 * 受信側ではフィルタ不正は REQUEST_ERROR (INVALID_FILTER) で応答するか、応答不能な
 * 経路 (PUBLISH_OK 受信等) では PROTOCOL_VIOLATION でセッションを閉じる。
 * 送信側 (encodeRangeFilter) ではローカル API 誤用 (SetID 範囲外・奇数 Property
 * Type・PRIORITY_FILTER 255 超・Range 絶対値 2^64-1 超過・空 ranges) を
 * 送信前に検出して throw する。
 * 送信側 (encodeLocationFilter) では §3.3.1 の End Group (StartGroup +
 * EndGroupDelta) が 2^64-1 を超える 3 / 4 フィールド表現を送信前に検出して
 * throw する (本エラーの Location Filter 関連用途は送信前検証専用で、受信側の
 * デコード (decodeLocationFilter) は ProtocolViolationError を使う)。
 * fetch() では追加で、相対指定 (0x01) / Next Object (0x05) の Location Filter と、
 * 同一 Group で End Object が Start Object より小さい空範囲も送信前に検出して
 * このエラーを throw する (いずれもワイヤに載せるとピアがエラーにする要求)。
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
 * draft-ietf-moq-transport-23 §11.3.2 (Closing Subgroup Streams):
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
