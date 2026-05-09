/**
 * MOQT Message Types
 * draft-ietf-moq-transport-17 Section 9 (Control Messages)
 */

/**
 * Message Types (Section 9 Control Messages)
 */
export const MessageType = {
  // draft-ietf-moq-transport-17 Section 9.4 (SETUP):
  // CLIENT_SETUP と SERVER_SETUP は単一の SETUP メッセージに統合された。
  // https://github.com/moq-wg/moq-transport/pull/1510
  SETUP: 0x2f00,

  // Session
  GOAWAY: 0x10,

  // Request/Response
  REQUEST_OK: 0x07,
  REQUEST_ERROR: 0x05,
  REQUEST_UPDATE: 0x02,

  // Subscribe
  SUBSCRIBE: 0x03,
  SUBSCRIBE_OK: 0x04,

  // Publish
  PUBLISH: 0x1d,
  PUBLISH_OK: 0x1e,
  PUBLISH_DONE: 0x0b,

  // Fetch
  FETCH: 0x16,
  FETCH_OK: 0x18,

  // Track Status
  TRACK_STATUS: 0x0d,

  // Namespace
  PUBLISH_NAMESPACE: 0x06,
  NAMESPACE: 0x08,
  NAMESPACE_DONE: 0x0e,
  /**
   * PUBLISH_BLOCKED (Section 9.21 PUBLISH_BLOCKED)
   *
   * draft-ietf-moq-transport-17:
   * Publisher が新しい Request ID を割り当てられない場合に送信する。
   * SUBSCRIBE_NAMESPACE のフロー制御の一環。
   * https://github.com/moq-wg/moq-transport/pull/1452
   */
  PUBLISH_BLOCKED: 0x0f,
  SUBSCRIBE_NAMESPACE: 0x11,
} as const;

export type MessageType = (typeof MessageType)[keyof typeof MessageType];

/**
 * Setup Option Types (Section 9.4.1 Setup Options)
 *
 * draft-ietf-moq-transport-17:
 * "Setup Parameters" を "Setup Options" にリネーム。
 * https://github.com/moq-wg/moq-transport/pull/1461
 */
export const SetupOptionType = {
  PATH: 0x01,
  /**
   * AUTHORIZATION_TOKEN (Section 9.4.1.4 AUTHORIZATION TOKEN Setup Option)
   *
   * draft-ietf-moq-transport-17:
   * SETUP で送出する認証トークン。値は Section 9.3.2 の Token 構造。
   * SETUP では Alias Type DELETE / USE_ALIAS は禁止（Section 9.3.2）。
   */
  AUTHORIZATION_TOKEN: 0x03,
  MAX_AUTH_TOKEN_CACHE_SIZE: 0x04,
  AUTHORITY: 0x05,
  MOQT_IMPLEMENTATION: 0x07,
} as const;

export type SetupOptionType = (typeof SetupOptionType)[keyof typeof SetupOptionType];

/**
 * Message Parameter Types (Section 9.3 Message Parameters)
 *
 * draft-ietf-moq-transport-17:
 * - Message Parameters は単一ホップにスコープされる
 * - 全ての Message Parameters は理解されなければならない（未知のものはエラー）
 * - Track Properties (DELIVERY_TIMEOUT, MAX_CACHE_DURATION, DEFAULT_PUBLISHER_PRIORITY,
 *   DEFAULT_PUBLISHER_GROUP_ORDER, DYNAMIC_GROUPS) は PUBLISH/SUBSCRIBE_OK/FETCH_OK の
 *   Track Extensions に移動
 * https://github.com/moq-wg/moq-transport/pull/1390
 *
 * 注意: SUBSCRIBE では DELIVERY_TIMEOUT, GROUP_ORDER は引き続き
 * Message Parameter として使用される（Subscriber の希望値）。
 */
export const MessageParameterType = {
  /**
   * DELIVERY_TIMEOUT (Section 9.3.3 DELIVERY TIMEOUT Parameter)
   *
   * SUBSCRIBE では Subscriber の希望値として Message Parameter で使用。
   * PUBLISH/SUBSCRIBE_OK/FETCH_OK では Track Extension として使用。
   */
  DELIVERY_TIMEOUT: 0x02,
  /**
   * AUTHORIZATION TOKEN (Section 9.3.2 AUTHORIZATION TOKEN Parameter)
   */
  AUTHORIZATION_TOKEN: 0x03,
  /**
   * RENDEZVOUS_TIMEOUT (Section 9.3.4 RENDEZVOUS TIMEOUT Parameter)
   *
   * draft-ietf-moq-transport-17:
   * SUBSCRIBE メッセージで使用。
   * リレーが Publisher を待つ時間（ミリ秒）。
   * 0 は即時応答を要求。不在の場合のデフォルト値は 0。
   * https://github.com/moq-wg/moq-transport/pull/1447
   */
  RENDEZVOUS_TIMEOUT: 0x04,
  /**
   * EXPIRES (Section 9.3.8 EXPIRES Parameter)
   */
  EXPIRES: 0x08,
  /**
   * LARGEST_OBJECT (Section 9.3.9 LARGEST OBJECT Parameter)
   */
  LARGEST_OBJECT: 0x09,
  /**
   * FORWARD (Section 9.3.10 FORWARD Parameter)
   */
  FORWARD: 0x10,
  /**
   * SUBSCRIBER_PRIORITY (Section 9.3.5 SUBSCRIBER PRIORITY Parameter)
   */
  SUBSCRIBER_PRIORITY: 0x20,
  /**
   * SUBSCRIPTION_FILTER (Section 9.3.7 SUBSCRIPTION FILTER Parameter)
   */
  SUBSCRIPTION_FILTER: 0x21,
  /**
   * GROUP_ORDER (Section 9.3.6 GROUP ORDER Parameter)
   *
   * SUBSCRIBE では Subscriber の希望値として Message Parameter で使用。
   * Publisher の GROUP_ORDER_PREFERENCE は Track Extension として使用。
   * https://github.com/moq-wg/moq-transport/pull/1390
   */
  GROUP_ORDER: 0x22,
  /**
   * NEW_GROUP_REQUEST (Section 9.3.11 NEW GROUP REQUEST Parameter)
   */
  NEW_GROUP_REQUEST: 0x32,
} as const;

export type MessageParameterType = (typeof MessageParameterType)[keyof typeof MessageParameterType];

/**
 * Group Order (Section 9.3.6 GROUP ORDER Parameter)
 */
export const GroupOrder = {
  ASCENDING: 0x01,
  DESCENDING: 0x02,
} as const;

export type GroupOrder = (typeof GroupOrder)[keyof typeof GroupOrder];

/**
 * Subscription Filter Types (Section 5.1.2 Subscription Filters)
 */
export const FilterType = {
  NEXT_GROUP_START: 0x01,
  LARGEST_OBJECT: 0x02,
  ABSOLUTE_START: 0x03,
  ABSOLUTE_RANGE: 0x04,
} as const;

export type FilterType = (typeof FilterType)[keyof typeof FilterType];

/**
 * Object Status (Section 10.2.1.1 Object Status)
 *
 * draft-ietf-moq-transport-17:
 * - 0x0: Normal object
 * - 0x3: End of Group (EOG)
 *   Indicates that no objects with the specified Group ID and the Object ID
 *   that is greater than or equal to the one specified exist.
 * - 0x4: End of Track (EOT)
 *   Indicates that no objects with the location that is equal to or greater
 *   than the one specified exist.
 *
 * Note: 0x1 (Object Does Not Exist) was removed in draft-16.
 * https://github.com/moq-wg/moq-transport/pull/1342
 */
export const ObjectStatus = {
  NORMAL: 0x0,
  END_OF_GROUP: 0x3,
  END_OF_TRACK: 0x4,
} as const;

export type ObjectStatus = (typeof ObjectStatus)[keyof typeof ObjectStatus];

/**
 * PUBLISH_DONE Status Codes (Section 9.13 PUBLISH_DONE)
 *
 * draft-ietf-moq-transport-17:
 * - 0x0: INTERNAL_ERROR
 * - 0x1: UNAUTHORIZED
 * - 0x2: TRACK_ENDED
 * - 0x3: SUBSCRIPTION_ENDED
 * - 0x4: GOING_AWAY
 * - 0x5: EXPIRED
 * - 0x6: TOO_FAR_BEHIND
 * - 0x8: UPDATE_FAILED
 * - 0x9: EXCESSIVE_LOAD
 * - 0x12: MALFORMED_TRACK
 */
export const PublishDoneStatusCode = {
  INTERNAL_ERROR: 0x0,
  UNAUTHORIZED: 0x1,
  TRACK_ENDED: 0x2,
  SUBSCRIPTION_ENDED: 0x3,
  GOING_AWAY: 0x4,
  EXPIRED: 0x5,
  TOO_FAR_BEHIND: 0x6,
  UPDATE_FAILED: 0x8,
  EXCESSIVE_LOAD: 0x9,
  MALFORMED_TRACK: 0x12,
} as const;

export type PublishDoneStatusCode =
  (typeof PublishDoneStatusCode)[keyof typeof PublishDoneStatusCode];

/**
 * PUBLISH_DONE の Status Code がエラー（アプリに Error として通知すべき）かどうか
 *
 * draft-ietf-moq-transport-17 Section 9.13 (PUBLISH_DONE):
 * INTERNAL_ERROR (0x0), UNAUTHORIZED (0x1), TOO_FAR_BEHIND (0x6), UPDATE_FAILED (0x8),
 * EXCESSIVE_LOAD (0x9), MALFORMED_TRACK (0x12) をエラーとみなす。
 * TRACK_ENDED (0x2) 等はエラーとみなさない。
 * https://www.ietf.org/archive/id/draft-ietf-moq-transport-17.html#section-9.13
 */
export function isPublishDoneErrorStatus(statusCode: bigint): boolean {
  switch (statusCode) {
    case 0x0n:
    case 0x1n:
    case 0x6n:
    case 0x8n:
    case 0x9n:
    case 0x12n:
      return true;
    default:
      return false;
  }
}

/**
 * Namespace Subscribe Mode (Section 9.20 SUBSCRIBE_NAMESPACE, Subscribe Options)
 *
 * draft-ietf-moq-transport-17:
 * SUBSCRIBE_NAMESPACE の Subscribe Options フィールドで使用される。
 * PUBLISH (0x00)、NAMESPACE (0x01)、BOTH (0x02) のいずれかを指定する。
 * https://www.ietf.org/archive/id/draft-ietf-moq-transport-17.html#section-9.20
 */
export const NamespaceSubscribeMode = {
  /**
   * PUBLISH のみを要求する
   */
  PUBLISH: 0x00,
  /**
   * NAMESPACE のみを要求する
   */
  NAMESPACE: 0x01,
  /**
   * PUBLISH と NAMESPACE の両方を要求する
   */
  BOTH: 0x02,
} as const;

export type NamespaceSubscribeMode =
  (typeof NamespaceSubscribeMode)[keyof typeof NamespaceSubscribeMode];

/**
 * Location (Group ID, Object ID)
 */
export interface Location {
  group: bigint;
  object: bigint;
}
