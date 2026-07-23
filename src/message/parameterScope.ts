/**
 * Parameter Scope 検証
 *
 * draft-ietf-moq-transport-19 §10.2.1 (Parameter Scope):
 * "An endpoint that receives a parameter in a context where it is not
 *  allowed MUST close the session with a PROTOCOL_VIOLATION."
 *
 * 各メッセージ種別ごとに許可パラメータ集合を定義し、
 * 受信時にパラメータ型をチェックする。
 */

import { MessageParameterType } from "./types";
import { SessionError, SessionErrorCode } from "../error";

// ============================================================================
// 許可パラメータ集合
// ============================================================================

/** SUBSCRIBE メッセージの許可パラメータ */
export const SUBSCRIBE_ALLOWED_PARAMS = new Set<number>([
  MessageParameterType.AUTHORIZATION_TOKEN,
  MessageParameterType.OBJECT_DELIVERY_TIMEOUT,
  MessageParameterType.SUBGROUP_DELIVERY_TIMEOUT,
  MessageParameterType.SUBSCRIBER_PRIORITY,
  MessageParameterType.FORWARD,
  MessageParameterType.LOCATION_FILTER,
  MessageParameterType.GROUP_ORDER,
  MessageParameterType.NEW_GROUP_REQUEST,
  MessageParameterType.RENDEZVOUS_TIMEOUT,
]);

/** SUBSCRIBE_OK メッセージの許可パラメータ */
export const SUBSCRIBE_OK_ALLOWED_PARAMS = new Set<number>([
  MessageParameterType.EXPIRES,
  MessageParameterType.LARGEST_OBJECT,
]);

/**
 * REQUEST_OK (PUBLISH_OK) の許可パラメータ
 *
 * draft-ietf-moq-transport-19 §10.2.8: GROUP_ORDER は PUBLISH_OK から削除
 */
export const PUBLISH_OK_ALLOWED_PARAMS = new Set<number>([
  MessageParameterType.OBJECT_DELIVERY_TIMEOUT,
  MessageParameterType.SUBGROUP_DELIVERY_TIMEOUT,
  MessageParameterType.SUBSCRIBER_PRIORITY,
  MessageParameterType.LOCATION_FILTER,
  MessageParameterType.FORWARD,
  MessageParameterType.NEW_GROUP_REQUEST,
  MessageParameterType.EXPIRES,
]);

/** REQUEST_OK (REQUEST_UPDATE_OK) の許可パラメータ */
export const REQUEST_UPDATE_OK_ALLOWED_PARAMS = new Set<number>([
  MessageParameterType.LARGEST_OBJECT,
  MessageParameterType.EXPIRES,
]);

/** REQUEST_OK (TRACK_STATUS_OK) の許可パラメータ */
export const TRACK_STATUS_OK_ALLOWED_PARAMS = new Set<number>([
  MessageParameterType.LARGEST_OBJECT,
]);

/**
 * REQUEST_OK (SUBSCRIBE_NAMESPACE_OK / SUBSCRIBE_TRACKS_OK / PUBLISH_NAMESPACE_OK) の許可パラメータ
 *
 * draft-ietf-moq-transport-19 §10.2.15 (EXPIRES Parameter):
 * "It MAY appear in SUBSCRIBE_OK, PUBLISH, PUBLISH_OK, SUBSCRIBE_NAMESPACE_OK,
 *  SUBSCRIBE_TRACKS_OK, PUBLISH_NAMESPACE_OK, or REQUEST_UPDATE_OK."
 */
export const NAMESPACE_OK_ALLOWED_PARAMS = new Set<number>([MessageParameterType.EXPIRES]);

/** REQUEST_UPDATE メッセージの許可パラメータ */
export const REQUEST_UPDATE_ALLOWED_PARAMS = new Set<number>([
  MessageParameterType.AUTHORIZATION_TOKEN,
  MessageParameterType.OBJECT_DELIVERY_TIMEOUT,
  MessageParameterType.SUBGROUP_DELIVERY_TIMEOUT,
  MessageParameterType.SUBSCRIBER_PRIORITY,
  MessageParameterType.FORWARD,
  MessageParameterType.LOCATION_FILTER,
  MessageParameterType.NEW_GROUP_REQUEST,
  MessageParameterType.TRACK_NAMESPACE_PREFIX,
]);

/** FETCH メッセージの許可パラメータ */
export const FETCH_ALLOWED_PARAMS = new Set<number>([
  MessageParameterType.AUTHORIZATION_TOKEN,
  MessageParameterType.FILL_TIMEOUT,
  MessageParameterType.SUBSCRIBER_PRIORITY,
  MessageParameterType.GROUP_ORDER,
]);

/**
 * PUBLISH メッセージの許可パラメータ
 *
 * draft-ietf-moq-transport-19 §10.19.1: SUBSCRIBE_TRACKS の結果 PUBLISH に
 * GROUP_ORDER が載るため許可する（Section 10.2.8 の MAY 列挙より 10.19.1 を優先）
 */
export const PUBLISH_ALLOWED_PARAMS = new Set<number>([
  MessageParameterType.AUTHORIZATION_TOKEN,
  MessageParameterType.EXPIRES,
  MessageParameterType.LARGEST_OBJECT,
  MessageParameterType.FORWARD,
  MessageParameterType.GROUP_ORDER,
]);

/** FETCH_OK メッセージの許可パラメータ */
export const FETCH_OK_ALLOWED_PARAMS = new Set<number>();

/** SUBSCRIBE_NAMESPACE / PUBLISH_NAMESPACE の許可パラメータ */
export const NAMESPACE_ALLOWED_PARAMS = new Set<number>([MessageParameterType.AUTHORIZATION_TOKEN]);

/**
 * SUBSCRIBE_TRACKS メッセージの許可パラメータ
 *
 * draft-ietf-moq-transport-19 §10.19.1 (Parameters on SUBSCRIBE_TRACKS):
 * AUTHORIZATION_TOKEN (§10.2.2) / FORWARD (§10.2.17) / GROUP_ORDER (§10.2.8)
 */
export const SUBSCRIBE_TRACKS_ALLOWED_PARAMS = new Set<number>([
  MessageParameterType.AUTHORIZATION_TOKEN,
  MessageParameterType.FORWARD,
  MessageParameterType.GROUP_ORDER,
]);

// ============================================================================
// 検証関数
// ============================================================================

/**
 * パラメータスコープを検証する
 *
 * draft-ietf-moq-transport-19 §10.2.1:
 * "An endpoint that receives a parameter in a context where it is not
 *  allowed MUST close the session with a PROTOCOL_VIOLATION."
 *
 * @param params - 検証するパラメータ配列
 * @param allowed - 許可パラメータ集合
 * @param contextName - コンテキスト名（エラーメッセージ用）
 * @param closeSession - セッションを閉じるコールバック
 * @returns バリデーション通過時は true、違反時は false
 */
export function validateParameterScope(
  params: Array<{ type: number }>,
  allowed: Set<number>,
  contextName: string,
  closeSession: (error: SessionError) => void,
): boolean {
  for (const param of params) {
    if (!allowed.has(param.type)) {
      closeSession(
        new SessionError(
          `parameter type 0x${param.type.toString(16)} not allowed in ${contextName}`,
          SessionErrorCode.PROTOCOL_VIOLATION,
        ),
      );
      return false;
    }
  }
  return true;
}
