/**
 * Parameter Scope 検証
 *
 * draft-ietf-moq-transport-22 §9.20.1 (Parameter Scope) に基づき、
 * 各メッセージ種別ごとに許可パラメータ集合を定義し、
 * 受信時にパラメータ型をチェックする。
 */

import { MessageParameterType } from "./types";
import { SessionError, SessionErrorCode } from "../error";

// ============================================================================
// 許可パラメータ集合
// ============================================================================

/**
 * SUBSCRIBE_OK メッセージの許可パラメータ
 *
 * draft-ietf-moq-transport-23 §9.7: EXPIRES / LARGEST_OBJECT のみ。
 */
export const SUBSCRIBE_OK_ALLOWED_PARAMS = new Set<number>([
  MessageParameterType.EXPIRES,
  MessageParameterType.LARGEST_OBJECT,
]);

/**
 * REQUEST_OK (PUBLISH_OK) の許可パラメータ
 *
 * draft-ietf-moq-transport-23 §9.3 (PUBLISH_OK) / §9.19.16 (EXPIRES Parameter):
 * EXPIRES のみが PUBLISH_OK に出現できる。Subscription Parameters
 * (LOCATION_FILTER / PAUSED / timeouts / SUBSCRIBER_PRIORITY /
 * NEW_GROUP_REQUEST / Range Filters 等) は REQUEST_UPDATE 側で扱い、
 * PUBLISH_OK では §9.19.1 に従いセッションを閉じる。
 */
export const PUBLISH_OK_ALLOWED_PARAMS = new Set<number>([MessageParameterType.EXPIRES]);

/** REQUEST_OK (REQUEST_UPDATE_OK) の許可パラメータ */
export const REQUEST_UPDATE_OK_ALLOWED_PARAMS = new Set<number>([
  MessageParameterType.LARGEST_OBJECT,
  MessageParameterType.EXPIRES,
]);

/**
 * PUBLISH_STATE_NOTIFY の許可パラメータ
 *
 * draft-ietf-moq-transport-23 §9.10 / §9.19.18:
 * LARGEST_OBJECT (0x09) / PAUSED (0x11) / LOCATION_FILTER (0x21) のみ。
 * 上記以外を受信した場合は §9.19.1 の MUST に従い INVALID_PARAMETER で
 * セッションを閉じる。
 */
export const PUBLISH_STATE_NOTIFY_ALLOWED_PARAMS = new Set<number>([
  MessageParameterType.LARGEST_OBJECT,
  MessageParameterType.PAUSED,
  MessageParameterType.LOCATION_FILTER,
]);

/**
 * REQUEST_OK (TRACK_STATUS_OK) の許可パラメータ
 *
 * draft-ietf-moq-transport-22 §9.13 (TRACK_STATUS) は TRACK_STATUS への応答を
 * 「SUBSCRIBE_OK で設定したのと同じ parameters と Track Properties を返す」と定め、
 * §9.20.16 (EXPIRES Parameter) は EXPIRES が SUBSCRIBE_OK に出現できるとするため、
 * 字義通りに読むと EXPIRES を TRACK_STATUS_OK でも受理すべきに見える。
 *
 * 本実装は §9.20.16 の出現先一覧 (SUBSCRIBE_OK / PUBLISH / PUBLISH_OK /
 * SUBSCRIBE_NAMESPACE_OK / SUBSCRIBE_TRACKS_OK / PUBLISH_NAMESPACE_OK /
 * REQUEST_UPDATE_OK) に TRACK_STATUS_OK が無いことを根拠に、EXPIRES を
 * スコープ違反 (§9.19.1 の MUST により INVALID_PARAMETER) として扱う。
 * 一覧を優先するのは、パラメータごとの出現先を列挙している §9.20.16 の方が
 * 応答の内容を述べる §9.13 より具体的であり、また TRACK_STATUS は購読を
 * 確立しないため EXPIRES (購読の有効期限) の意味が定まらないためである。
 * 相互運用を優先して EXPIRES を許容する判断に変える場合は、本集合に
 * MessageParameterType.EXPIRES を追加する。
 */
export const TRACK_STATUS_OK_ALLOWED_PARAMS = new Set<number>([
  MessageParameterType.LARGEST_OBJECT,
]);

/**
 * REQUEST_OK (SUBSCRIBE_NAMESPACE_OK / SUBSCRIBE_TRACKS_OK / PUBLISH_NAMESPACE_OK) の許可パラメータ
 *
 * draft-ietf-moq-transport-22 §9.20.16 (EXPIRES Parameter):
 * "It MAY appear in SUBSCRIBE_OK, PUBLISH, PUBLISH_OK, SUBSCRIBE_NAMESPACE_OK,
 *  SUBSCRIBE_TRACKS_OK, PUBLISH_NAMESPACE_OK, or REQUEST_UPDATE_OK."
 */
export const NAMESPACE_OK_ALLOWED_PARAMS = new Set<number>([MessageParameterType.EXPIRES]);

/**
 * NAMESPACE メッセージの許可パラメータ
 *
 * draft-ietf-moq-transport-23 §9.15 (NAMESPACE):
 * "Parameters: The parameters are defined in Section 9.19."
 * §9.15 は PUBLISH_NAMESPACE (§9.13) / SUBSCRIBE_NAMESPACE (§9.14) のように
 * 「出現できるパラメータ」を列挙していないが、§9.19 の各パラメータ定義の
 * "It MAY appear in ..." のいずれにも NAMESPACE は含まれていない。つまり現在の
 * draft が NAMESPACE に定義するパラメータは存在せず、Parameters フィールドは
 * 拡張が NAMESPACE 用のパラメータを定義するための枠である。
 *
 * draft-ietf-moq-transport-23 §9.19.1 (Parameter Scope):
 * "Each Message Parameter definition indicates the message types in which it can
 *  appear, and each control message definition lists the parameters it allows.
 *  If a parameter appears in some other type of message, the receiving endpoint
 *  MUST close the session with INVALID_PARAMETER."
 * したがって現在は空集合であり、NAMESPACE で既知の Message Parameter を受信した
 * 場合はスコープ違反として INVALID_PARAMETER でセッションを閉じる (未知の型は
 * decodeParameters が同じ INVALID_PARAMETER で拒否する)。拡張が NAMESPACE 用の
 * パラメータを定義し、本実装がその拡張を交渉できるようになった場合は、この集合へ
 * 追加する。
 */
export const NAMESPACE_ALLOWED_PARAMS = new Set<number>();

/**
 * subscription 系 REQUEST_UPDATE の許可パラメータ
 *
 * draft-ietf-moq-transport-22 §9.20 の各パラメータ定義が、通常の
 * subscription (SUBSCRIBE / PUBLISH / FETCH) を対象とする REQUEST_UPDATE で
 * 出現を許可する型の集合である。
 *
 * - AUTHORIZATION_TOKEN (§9.20.2): REQUEST_UPDATE に出現可能。
 * - OBJECT_DELIVERY_TIMEOUT (§9.20.4) / SUBGROUP_DELIVERY_TIMEOUT (§9.20.3):
 *   REQUEST_UPDATE に出現可能。
 * - SUBSCRIBER_PRIORITY (§9.20.7): REQUEST_UPDATE (for a subscription or FETCH)。
 * - PAUSED (§9.19.18): REQUEST_UPDATE (for a subscription or a
 *   SUBSCRIBE_TRACKS request)。
 * - LOCATION_FILTER (§9.20.9): REQUEST_UPDATE (for a subscription)。
 * - NEW_GROUP_REQUEST (§9.20.19): REQUEST_UPDATE for a subscription。
 * - FILL_PARAMETERS (§9.20.15): REQUEST_UPDATE (for a subscription)。
 * - Range Filters (§3.3.2): SUBGROUP_FILTER / OBJECTID_FILTER /
 *   PRIORITY_FILTER / OBJECT_PROPERTY_FILTER は REQUEST_UPDATE (on a
 *   subscription, from the subscriber only)。
 *
 * TRACK_NAMESPACE_PREFIX (§9.20.20) は namespace 系
 * (SUBSCRIBE_NAMESPACE / SUBSCRIBE_TRACKS) の REQUEST_UPDATE にのみ出現可能な
 * ため、本集合には含めない。通常の PUBLISH / SUBSCRIBE 系 REQUEST_UPDATE で
 * 受信した場合は §9.19.1 の MUST により INVALID_PARAMETER でセッションを
 * 閉じる (NAMESPACE_REQUEST_UPDATE_ALLOWED_PARAMS を参照)。
 *
 * TRACK_PROPERTY_FILTER (0x29) も SUBSCRIBE_TRACKS とその REQUEST_UPDATE に
 * のみ出現可能なため、本集合には含めない。
 */
export const REQUEST_UPDATE_ALLOWED_PARAMS = new Set<number>([
  MessageParameterType.AUTHORIZATION_TOKEN,
  MessageParameterType.OBJECT_DELIVERY_TIMEOUT,
  MessageParameterType.SUBGROUP_DELIVERY_TIMEOUT,
  MessageParameterType.SUBSCRIBER_PRIORITY,
  MessageParameterType.PAUSED,
  MessageParameterType.LOCATION_FILTER,
  MessageParameterType.NEW_GROUP_REQUEST,
  // draft-ietf-moq-transport-22 §9.20.15: FILL_PARAMETERS (subscription の REQUEST_UPDATE)
  MessageParameterType.FILL_PARAMETERS,
  // draft-ietf-moq-transport-22 §3.3.2: Range Filters (subscription の REQUEST_UPDATE)
  MessageParameterType.SUBGROUP_FILTER,
  MessageParameterType.OBJECTID_FILTER,
  MessageParameterType.PRIORITY_FILTER,
  MessageParameterType.OBJECT_PROPERTY_FILTER,
]);

/**
 * namespace 系 REQUEST_UPDATE の許可パラメータ
 *
 * draft-ietf-moq-transport-22 §9.5 (REQUEST_UPDATE) の SUBSCRIBE_NAMESPACE /
 * SUBSCRIBE_TRACKS 向け一覧に対応する。
 * - SUBSCRIBE_NAMESPACE: AUTHORIZATION_TOKEN (§9.19.2) / TRACK_NAMESPACE_PREFIX (§9.19.20)
 * - SUBSCRIBE_TRACKS: AUTHORIZATION_TOKEN / PAUSED (§9.19.18) /
 *   TRACK_PROPERTY_FILTER (§9.19.14) / TRACK_NAMESPACE_PREFIX
 *
 * moqt-js は SUBSCRIBE_NAMESPACE / SUBSCRIBE_TRACKS を送信するため、送信経路
 * (bidiSendNamespaceRequestUpdate) の防御的検証に使う。TRACK_PROPERTY_FILTER は
 * 現時点で送信 API を持たないが、§9.5 の一覧に合わせておき、将来 API を足した
 * ときに検証が漏れないようにする。
 */
export const NAMESPACE_REQUEST_UPDATE_ALLOWED_PARAMS = new Set<number>([
  MessageParameterType.TRACK_NAMESPACE_PREFIX,
  MessageParameterType.AUTHORIZATION_TOKEN,
  MessageParameterType.PAUSED,
  MessageParameterType.TRACK_PROPERTY_FILTER,
]);

/**
 * PUBLISH メッセージの許可パラメータ
 *
 * draft-ietf-moq-transport-23 §9.8 (PUBLISH):
 * PAUSED / GROUP_ORDER / SUBSCRIBER_PRIORITY / SUBGROUP_DELIVERY_TIMEOUT /
 * OBJECT_DELIVERY_TIMEOUT / LOCATION_FILTER を初期 Subscription Parameters
 * として運べる。§3.6.2 により SUBSCRIBE_TRACKS 由来の PUBLISH でも明示される。
 * NEW_GROUP_REQUEST / Range Filters は PUBLISH に出現できない
 * (FILL_PARAMETERS は未対応のため PUBLISH では受理しない)。
 *
 * draft-ietf-moq-transport-23 §9.19.21 (SUBSCRIBE_TRACKS_ID):
 * SUBSCRIBE_TRACKS の結果として送信された PUBLISH にだけ出現する。受信側は
 * この値で PUBLISH を元の SUBSCRIBE_TRACKS の要求へ結び付ける (§3.6)。
 * PUBLISH 以外のメッセージで受信した場合は §9.19.1 の MUST により
 * INVALID_PARAMETER でセッションを閉じる (本集合に含めない)。
 */
export const PUBLISH_ALLOWED_PARAMS = new Set<number>([
  MessageParameterType.AUTHORIZATION_TOKEN,
  MessageParameterType.EXPIRES,
  MessageParameterType.LARGEST_OBJECT,
  MessageParameterType.PAUSED,
  MessageParameterType.GROUP_ORDER,
  MessageParameterType.OBJECT_DELIVERY_TIMEOUT,
  MessageParameterType.SUBGROUP_DELIVERY_TIMEOUT,
  MessageParameterType.SUBSCRIBER_PRIORITY,
  MessageParameterType.LOCATION_FILTER,
  MessageParameterType.SUBSCRIBE_TRACKS_ID,
]);

/**
 * FETCH_OK メッセージの許可パラメータ
 *
 * draft-ietf-moq-transport-23 §9.3 (REQUEST_OK):
 * FETCH_OK は REQUEST_OK の別名 (§1.5) であり、FETCH への成功応答として
 * EXPIRES と LARGEST_OBJECT を運べる。LARGEST_OBJECT は §3.2 / §9.19.17 により
 * Largest Object が要求範囲内のときだけ必須で、応答の終端確定に使う。
 * Track Properties は FETCH_OK でも populate される (§9.3)。
 */
export const FETCH_OK_ALLOWED_PARAMS = new Set<number>([
  MessageParameterType.EXPIRES,
  MessageParameterType.LARGEST_OBJECT,
]);

// ============================================================================
// 検証関数
// ============================================================================

/**
 * パラメータスコープを検証する
 *
 * draft-ietf-moq-transport-23 §9.19.1:
 * "Each Message Parameter definition indicates the message types in
 *  which it can appear, and each control message definition lists the
 *  parameters it allows.  If a parameter appears in some other type of
 *  message, the receiving endpoint MUST close the connection with
 *  INVALID_PARAMETER."
 *
 * @param params - 検証するパラメータ配列
 * @param allowed - 許可パラメータ集合
 * @param contextName - コンテキスト名（エラーメッセージ用）
 * @returns バリデーション通過時は null、違反時は INVALID_PARAMETER の SessionError。
 *   呼び出し元は null でない場合、その文脈の保留中リクエストを reject したうえで
 *   closeWithError すること (保留が無い経路は closeWithError のみ)
 */
export function validateParameterScope(
  params: Array<{ type: number }>,
  allowed: Set<number>,
  contextName: string,
): SessionError | null {
  for (const param of params) {
    if (!allowed.has(param.type)) {
      return new SessionError(
        `parameter type 0x${param.type.toString(16)} not allowed in ${contextName}`,
        SessionErrorCode.INVALID_PARAMETER,
      );
    }
  }
  return null;
}

/**
 * 送信パラメータがメッセージ種別で許可されていることを検証する
 *
 * draft-ietf-moq-transport-23 §9.19 の各パラメータ定義が示す出現可能
 * メッセージに反する型を送信前に拒否する。受信側では §9.19.1 の MUST により
 * INVALID_PARAMETER でセッションが閉じられるため、送信側のローカル API 誤用
 * としてセッションを閉じず throw で呼び出し元へ返す。
 *
 * @param params - 検証するパラメータ配列
 * @param allowed - 許可パラメータ集合
 * @param contextName - コンテキスト名（エラーメッセージ用）
 * @throws Error 許可されない型が含まれる場合
 */
export function assertParametersAllowedForSend(
  params: Array<{ type: number }>,
  allowed: Set<number>,
  contextName: string,
): void {
  for (const param of params) {
    if (!allowed.has(param.type)) {
      throw new Error(`parameter type 0x${param.type.toString(16)} not allowed in ${contextName}`);
    }
  }
}
