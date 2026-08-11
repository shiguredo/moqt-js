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
  // draft-ietf-moq-transport-19 §5.1.3: Range Filters
  MessageParameterType.SUBGROUP_FILTER,
  MessageParameterType.OBJECTID_FILTER,
  MessageParameterType.PRIORITY_FILTER,
  MessageParameterType.OBJECT_PROPERTY_FILTER,
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
 * draft-ietf-moq-transport-19 §5.1.3: Range Filters (0x25–0x28) は PUBLISH_OK に許可
 */
export const PUBLISH_OK_ALLOWED_PARAMS = new Set<number>([
  MessageParameterType.OBJECT_DELIVERY_TIMEOUT,
  MessageParameterType.SUBGROUP_DELIVERY_TIMEOUT,
  MessageParameterType.SUBSCRIBER_PRIORITY,
  MessageParameterType.LOCATION_FILTER,
  MessageParameterType.FORWARD,
  MessageParameterType.NEW_GROUP_REQUEST,
  MessageParameterType.EXPIRES,
  // draft-ietf-moq-transport-19 §5.1.3: Range Filters
  MessageParameterType.SUBGROUP_FILTER,
  MessageParameterType.OBJECTID_FILTER,
  MessageParameterType.PRIORITY_FILTER,
  MessageParameterType.OBJECT_PROPERTY_FILTER,
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

/**
 * 受信 PUBLISH ストリーム上の REQUEST_UPDATE (ケース 1) で REQUEST_OK で
 * 受理するパラメータ
 *
 * draft-ietf-moq-transport-19 §10.9 (REQUEST_UPDATE):
 * ケース 1「The sender of a request (SUBSCRIBE, PUBLISH, FETCH,
 * PUBLISH_NAMESPACE, SUBSCRIBE_NAMESPACE, SUBSCRIBE_TRACKS) can later send a
 * REQUEST_UPDATE on the same bidi stream as the request to modify it.」の
 * うち publisher が自身の PUBLISH を更新する場合に REQUEST_OK で受理する。
 *
 * 受理基準は moqt-js 内部の PUBLISH_ALLOWED_PARAMS ではなく、draft-19 §10.2
 * の各パラメータ定義が REQUEST_UPDATE を無限定で許可するか否かである。
 * 無限定で許可されるのは AUTHORIZATION_TOKEN (§10.2.2) /
 * OBJECT_DELIVERY_TIMEOUT (§10.2.4) / SUBGROUP_DELIVERY_TIMEOUT (§10.2.3)
 * の 3 種のみ。文脈限定パラメータ (SUBSCRIBER_PRIORITY (§10.2.7) /
 * FORWARD (§10.2.17) / LOCATION_FILTER (§10.2.9) / NEW_GROUP_REQUEST
 * (§10.2.18) / TRACK_NAMESPACE_PREFIX (§10.2.19) / Range Filters
 * (SUBGROUP_FILTER / OBJECTID_FILTER / PRIORITY_FILTER /
 * OBJECT_PROPERTY_FILTER / TRACK_PROPERTY_FILTER、§5.1.3)) は REQUEST_UPDATE
 * 自体には出現可能なためスコープ検証は通過するが REQUEST_OK では受理せず、
 * REQUEST_ERROR (NOT_SUPPORTED) で応答する (文脈限定パラメータの許可拡大は
 * 将来の対応とする)。特に Range Filters は §5.1.3「... in a REQUEST_UPDATE
 * (on a subscription, from the subscriber only) message」により、ケース 1
 * の送信者 (publisher) には出現できない。
 */
export const PUBLISH_REQUEST_UPDATE_OK_PARAMS = new Set<number>([
  MessageParameterType.AUTHORIZATION_TOKEN,
  MessageParameterType.OBJECT_DELIVERY_TIMEOUT,
  MessageParameterType.SUBGROUP_DELIVERY_TIMEOUT,
]);

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
  // draft-ietf-moq-transport-19 §5.1.3: Range Filters (subscription の REQUEST_UPDATE)
  MessageParameterType.SUBGROUP_FILTER,
  MessageParameterType.OBJECTID_FILTER,
  MessageParameterType.PRIORITY_FILTER,
  MessageParameterType.OBJECT_PROPERTY_FILTER,
  MessageParameterType.TRACK_PROPERTY_FILTER,
]);

/** FETCH メッセージの許可パラメータ */
export const FETCH_ALLOWED_PARAMS = new Set<number>([
  MessageParameterType.AUTHORIZATION_TOKEN,
  MessageParameterType.FILL_TIMEOUT,
  MessageParameterType.SUBSCRIBER_PRIORITY,
  MessageParameterType.GROUP_ORDER,
  // draft-ietf-moq-transport-19 §5.1.3: Range Filters
  MessageParameterType.SUBGROUP_FILTER,
  MessageParameterType.OBJECTID_FILTER,
  MessageParameterType.PRIORITY_FILTER,
  MessageParameterType.OBJECT_PROPERTY_FILTER,
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
 * draft-ietf-moq-transport-19 §5.1.3: Range Filters (TRACK_PROPERTY_FILTER 含む)
 */
export const SUBSCRIBE_TRACKS_ALLOWED_PARAMS = new Set<number>([
  MessageParameterType.AUTHORIZATION_TOKEN,
  MessageParameterType.FORWARD,
  MessageParameterType.GROUP_ORDER,
  // draft-ietf-moq-transport-19 §5.1.3: Range Filters
  MessageParameterType.SUBGROUP_FILTER,
  MessageParameterType.OBJECTID_FILTER,
  MessageParameterType.PRIORITY_FILTER,
  MessageParameterType.OBJECT_PROPERTY_FILTER,
  MessageParameterType.TRACK_PROPERTY_FILTER,
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
