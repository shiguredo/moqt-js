/**
 * Parameter Scope 検証
 *
 * draft-ietf-moq-transport-21 §9.20.1 (Parameter Scope):
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

/** SUBSCRIBE_OK メッセージの許可パラメータ */
export const SUBSCRIBE_OK_ALLOWED_PARAMS = new Set<number>([
  MessageParameterType.EXPIRES,
  MessageParameterType.LARGEST_OBJECT,
]);

/**
 * REQUEST_OK (PUBLISH_OK) の許可パラメータ
 *
 * draft-ietf-moq-transport-21 §9.20.17 (EXPIRES Parameter):
 * EXPIRES のみが PUBLISH_OK に出現できる。Subscription Parameters
 * (LOCATION_FILTER / FORWARD / timeouts / SUBSCRIBER_PRIORITY /
 * NEW_GROUP_REQUEST / Range Filters 等) は REQUEST_UPDATE 側で扱い、
 * PUBLISH_OK では §9.20.1 に従い PROTOCOL_VIOLATION で拒否する。
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
 * draft-ietf-moq-transport-21 §9.10 (§9.20.18 LARGEST_OBJECT /
 * §9.20.19 FORWARD / §9.20.10 LOCATION_FILTER の各定義):
 * LARGEST_OBJECT (0x09) / FORWARD (0x10) / LOCATION_FILTER (0x21) のみ。
 * 上記以外を受信した場合は §9.20.1 の MUST に従い PROTOCOL_VIOLATION で
 * セッションを閉じる。
 */
export const PUBLISH_STATE_NOTIFY_ALLOWED_PARAMS = new Set<number>([
  MessageParameterType.LARGEST_OBJECT,
  MessageParameterType.FORWARD,
  MessageParameterType.LOCATION_FILTER,
]);

/** REQUEST_OK (TRACK_STATUS_OK) の許可パラメータ */
export const TRACK_STATUS_OK_ALLOWED_PARAMS = new Set<number>([
  MessageParameterType.LARGEST_OBJECT,
]);

/**
 * REQUEST_OK (SUBSCRIBE_NAMESPACE_OK / SUBSCRIBE_TRACKS_OK / PUBLISH_NAMESPACE_OK) の許可パラメータ
 *
 * draft-ietf-moq-transport-21 §9.20.17 (EXPIRES Parameter):
 * "It MAY appear in SUBSCRIBE_OK, PUBLISH, PUBLISH_OK, SUBSCRIBE_NAMESPACE_OK,
 *  SUBSCRIBE_TRACKS_OK, PUBLISH_NAMESPACE_OK, or REQUEST_UPDATE_OK."
 */
export const NAMESPACE_OK_ALLOWED_PARAMS = new Set<number>([MessageParameterType.EXPIRES]);

/**
 * subscription 系 REQUEST_UPDATE の許可パラメータ
 *
 * draft-ietf-moq-transport-21 §9.20 の各パラメータ定義が、通常の
 * subscription (SUBSCRIBE / PUBLISH / FETCH) を対象とする REQUEST_UPDATE で
 * 出現を許可する型の集合である。
 *
 * - AUTHORIZATION_TOKEN (§9.20.3): REQUEST_UPDATE に出現可能。
 * - OBJECT_DELIVERY_TIMEOUT (§9.20.5) / SUBGROUP_DELIVERY_TIMEOUT (§9.20.4):
 *   REQUEST_UPDATE に出現可能。
 * - SUBSCRIBER_PRIORITY (§9.20.8): REQUEST_UPDATE (for a subscription or FETCH)。
 * - FORWARD (§9.20.19): REQUEST_UPDATE (for a subscription or a
 *   SUBSCRIBE_TRACKS request)。
 * - LOCATION_FILTER (§9.20.10): REQUEST_UPDATE (for a subscription)。
 * - NEW_GROUP_REQUEST (§9.20.20): REQUEST_UPDATE for a subscription。
 * - FILL_PARAMETERS (§9.20.16): REQUEST_UPDATE (for a subscription)。
 * - Range Filters (§3.3.2): SUBGROUP_FILTER / OBJECTID_FILTER /
 *   PRIORITY_FILTER / OBJECT_PROPERTY_FILTER は REQUEST_UPDATE (on a
 *   subscription, from the subscriber only)。
 *
 * TRACK_NAMESPACE_PREFIX (§9.20.21) は namespace 系
 * (SUBSCRIBE_NAMESPACE / SUBSCRIBE_TRACKS) の REQUEST_UPDATE にのみ出現可能な
 * ため、本集合には含めない。通常の PUBLISH / SUBSCRIBE 系 REQUEST_UPDATE で
 * 受信した場合は §9.20.1 の MUST により PROTOCOL_VIOLATION でセッションを
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
  MessageParameterType.FORWARD,
  MessageParameterType.LOCATION_FILTER,
  MessageParameterType.NEW_GROUP_REQUEST,
  // draft-ietf-moq-transport-21 §9.20.16: FILL_PARAMETERS (subscription の REQUEST_UPDATE)
  MessageParameterType.FILL_PARAMETERS,
  // draft-ietf-moq-transport-21 §3.3.2: Range Filters (subscription の REQUEST_UPDATE)
  MessageParameterType.SUBGROUP_FILTER,
  MessageParameterType.OBJECTID_FILTER,
  MessageParameterType.PRIORITY_FILTER,
  MessageParameterType.OBJECT_PROPERTY_FILTER,
]);

/**
 * namespace 系 REQUEST_UPDATE の許可パラメータ
 *
 * draft-ietf-moq-transport-21 §9.20.21 (TRACK_NAMESPACE_PREFIX Parameter):
 * "It MAY appear in REQUEST_UPDATE for a SUBSCRIBE_NAMESPACE or
 *  SUBSCRIBE_TRACKS request."
 * 併せて §9.20.3 (AUTHORIZATION_TOKEN) は REQUEST_UPDATE に出現可能であり、
 * §9.20.19 (FORWARD) は REQUEST_UPDATE (for a SUBSCRIBE_TRACKS request) で
 * 出現可能である。moqt-js は SUBSCRIBE_NAMESPACE / SUBSCRIBE_TRACKS を送信
 * するため、送信経路 (bidiSendNamespaceRequestUpdate) の防御的検証に使う。
 */
export const NAMESPACE_REQUEST_UPDATE_ALLOWED_PARAMS = new Set<number>([
  MessageParameterType.TRACK_NAMESPACE_PREFIX,
  MessageParameterType.AUTHORIZATION_TOKEN,
  MessageParameterType.FORWARD,
]);

/**
 * PUBLISH メッセージの許可パラメータ
 *
 * draft-ietf-moq-transport-21 §9.8 (PUBLISH):
 * FORWARD / GROUP_ORDER / SUBSCRIBER_PRIORITY / SUBGROUP_DELIVERY_TIMEOUT /
 * OBJECT_DELIVERY_TIMEOUT / LOCATION_FILTER を初期 Subscription Parameters
 * として運べる。§9.18.1 により SUBSCRIBE_TRACKS 由来の PUBLISH でも明示される。
 * NEW_GROUP_REQUEST / Range Filters / FILL_PARAMETERS は PUBLISH に出現できない。
 */
export const PUBLISH_ALLOWED_PARAMS = new Set<number>([
  MessageParameterType.AUTHORIZATION_TOKEN,
  MessageParameterType.EXPIRES,
  MessageParameterType.LARGEST_OBJECT,
  MessageParameterType.FORWARD,
  MessageParameterType.GROUP_ORDER,
  MessageParameterType.OBJECT_DELIVERY_TIMEOUT,
  MessageParameterType.SUBGROUP_DELIVERY_TIMEOUT,
  MessageParameterType.SUBSCRIBER_PRIORITY,
  MessageParameterType.LOCATION_FILTER,
]);

/** FETCH_OK メッセージの許可パラメータ */
export const FETCH_OK_ALLOWED_PARAMS = new Set<number>();

// ============================================================================
// 検証関数
// ============================================================================

/**
 * パラメータスコープを検証する
 *
 * draft-ietf-moq-transport-21 §9.20.1:
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

/**
 * 送信パラメータがメッセージ種別で許可されていることを検証する
 *
 * draft-ietf-moq-transport-21 §9.20 の各パラメータ定義が示す出現可能
 * メッセージに反する型を送信前に拒否する。受信側では §9.20.1 の MUST により
 * PROTOCOL_VIOLATION でセッションが閉じられるため、送信側のローカル API 誤用
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
