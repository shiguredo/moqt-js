/**
 * MOQT Message Types
 * draft-ietf-moq-transport-18 Section 10 (Control Messages)
 */

/**
 * Message Types (Section 10 Control Messages)
 */
export const MessageType = {
  // draft-ietf-moq-transport-18 Section 3.3:
  // CLIENT_SETUP と SERVER_SETUP は単一の SETUP メッセージに統合された。
  // draft-ietf-moq-transport-18 Section 10.3
  SETUP: 0x2f00,

  // セッション
  GOAWAY: 0x10,

  // リクエスト/レスポンス
  REQUEST_OK: 0x07,
  REQUEST_ERROR: 0x05,
  REQUEST_UPDATE: 0x02,

  // Subscribe
  SUBSCRIBE: 0x03,
  SUBSCRIBE_OK: 0x04,

  // Publish
  PUBLISH: 0x1d,
  PUBLISH_DONE: 0x0b,

  // Fetch
  FETCH: 0x16,
  FETCH_OK: 0x18,

  // トラックステータス
  TRACK_STATUS: 0x0d,

  // Namespace
  PUBLISH_NAMESPACE: 0x06,
  NAMESPACE: 0x08,
  NAMESPACE_DONE: 0x0e,
  /**
   * PUBLISH_SKIPPED (Section 10.20 PUBLISH_SKIPPED)
   *
   * draft-ietf-moq-transport-19 Section 10.20 (PUBLISH_SKIPPED):
   * Publisher が Track に対する PUBLISH を送信しないことを示す。
   * SUBSCRIBE_TRACKS の応答ストリーム上で送信される。
   * draft-ietf-moq-transport-19 Section 6.1: "or any other reason"
   */
  PUBLISH_SKIPPED: 0x0f,
  /**
   * SUBSCRIBE_NAMESPACE (Section 10.18 SUBSCRIBE_NAMESPACE)
   *
   * draft-ietf-moq-transport-18:
   * 旧 SUBSCRIBE_NAMESPACE (0x11) が SUBSCRIBE_NAMESPACE (0x50) と
   * SUBSCRIBE_TRACKS (0x51) に分割された。
   * 0x50 は namespace discovery (NAMESPACE / NAMESPACE_DONE 受信) を担当する。
   * draft-ietf-moq-transport-18 Section 10.18
   */
  SUBSCRIBE_NAMESPACE: 0x50,
  /**
   * SUBSCRIBE_TRACKS (Section 10.19 SUBSCRIBE_TRACKS)
   *
   * draft-ietf-moq-transport-18:
   * track subscription (PUBLISH メッセージは新規 bidi で到着、
   * PUBLISH_SKIPPED は応答ストリーム上で到着) を担当する。
   * draft-ietf-moq-transport-18 Section 10.19
   */
  SUBSCRIBE_TRACKS: 0x51,
} as const;

export type MessageType = (typeof MessageType)[keyof typeof MessageType];

/**
 * Setup Option Types (Section 10.3.1 Setup Options)
 *
 * draft-ietf-moq-transport-18 Section 10.3.1, Section 15.4 (IANA registry)
 *
 * draft-ietf-moq-transport-18 §10.3.1:
 * "Setup Options with reserved identifiers have no semantics and can
 *  carry arbitrary values. Endpoints MUST ignore unknown Setup Options."
 */
export const SetupOptionType = {
  PATH: 0x01,
  /**
   * AUTHORIZATION_TOKEN (Section 10.3.1.4 AUTHORIZATION TOKEN Setup Option)
   *
   * draft-ietf-moq-transport-18:
   * SETUP で送出する認証トークン。値は Section 10.2.2 の Token 構造。
   * SETUP では Alias Type DELETE / USE_ALIAS は禁止（Section 10.2.2）。
   */
  AUTHORIZATION_TOKEN: 0x03,
  MAX_AUTH_TOKEN_CACHE_SIZE: 0x04,
  AUTHORITY: 0x05,
  MOQT_IMPLEMENTATION: 0x07,
  /**
   * MAX_REQUEST_UPDATES (Section 10.3.1.7)
   *
   * draft-ietf-moq-transport-19:
   * リクエストストリームごとの未応答 REQUEST_UPDATE の最大数。
   * 0 は無制限。欠落時のデフォルトも 0。
   */
  MAX_REQUEST_UPDATES: 0x08,
} as const;

export type SetupOptionType = (typeof SetupOptionType)[keyof typeof SetupOptionType];

/**
 * Message Parameter Types (Section 10.2 Message Parameters)
 *
 * draft-ietf-moq-transport-18:
 * - Message Parameters は単一ホップにスコープされる
 * - 全ての Message Parameters は理解されなければならない（未知のものはエラー）
 * - Track Properties (OBJECT_DELIVERY_TIMEOUT, MAX_CACHE_DURATION, DEFAULT_PUBLISHER_PRIORITY,
 *   DEFAULT_PUBLISHER_GROUP_ORDER, DYNAMIC_GROUPS) は PUBLISH/SUBSCRIBE_OK/FETCH_OK の
 *   Track Properties に移動
 * draft-ietf-moq-transport-18 Section 10.2 (Message Parameters)
 *
 * 注意: SUBSCRIBE では OBJECT_DELIVERY_TIMEOUT, GROUP_ORDER は引き続き
 * Message Parameter として使用される（Subscriber の希望値）。
 */
export const MessageParameterType = {
  /**
   * OBJECT_DELIVERY_TIMEOUT (Section 10.2.4 OBJECT_DELIVERY_TIMEOUT Parameter)
   *
   * SUBSCRIBE では Subscriber の希望値として Message Parameter で使用。
   * PUBLISH/SUBSCRIBE_OK/FETCH_OK では Track Property として使用。
   */
  OBJECT_DELIVERY_TIMEOUT: 0x02,
  /**
   * AUTHORIZATION TOKEN (Section 10.2.2 AUTHORIZATION TOKEN Parameter)
   */
  AUTHORIZATION_TOKEN: 0x03,
  /**
   * RENDEZVOUS_TIMEOUT (Section 10.2.6 RENDEZVOUS TIMEOUT Parameter)
   *
   * draft-ietf-moq-transport-18:
   * SUBSCRIBE メッセージで使用。
   * リレーが Publisher を待つ時間（ミリ秒）。
   * 0 は即時応答を要求。不在の場合のデフォルト値は 0。
   * draft-ietf-moq-transport-18 Section 10.2.6
   */
  RENDEZVOUS_TIMEOUT: 0x04,
  /**
   * SUBGROUP_DELIVERY_TIMEOUT (Section 10.2.3 SUBGROUP_DELIVERY TIMEOUT Parameter)
   *
   * draft-ietf-moq-transport-18:
   * SUBGROUP_DELIVERY_TIMEOUT パラメータは varint。
   * PUBLISH_OK / SUBSCRIBE / REQUEST_UPDATE に出現可能。
   * 単位はミリ秒。0 はタイムアウトなしを意味する。
   * draft-ietf-moq-transport-18 Section 10.2.3
   */
  SUBGROUP_DELIVERY_TIMEOUT: 0x06,
  /**
   * EXPIRES (Section 10.2.10 EXPIRES Parameter)
   */
  EXPIRES: 0x08,
  /**
   * LARGEST_OBJECT (Section 10.2.11 LARGEST OBJECT Parameter)
   */
  LARGEST_OBJECT: 0x09,
  /**
   * FILL_TIMEOUT (Section 10.2.5 FILL TIMEOUT Parameter)
   *
   * FETCH メッセージで使用。
   * relay が欠損 object の fill 待機に費やす最大時間（ミリ秒）。
   * 0 は即座に利用可能な object のみを要求。
   */
  FILL_TIMEOUT: 0x0a,
  /**
   * FORWARD (Section 10.2.12 FORWARD Parameter)
   */
  FORWARD: 0x10,
  /**
   * SUBSCRIBER_PRIORITY (Section 10.2.7 SUBSCRIBER PRIORITY Parameter)
   */
  SUBSCRIBER_PRIORITY: 0x20,
  /**
   * LOCATION_FILTER (Section 10.2.9 SUBSCRIPTION FILTER Parameter)
   */
  LOCATION_FILTER: 0x21,
  /**
   * GROUP_ORDER (Section 10.2.8 GROUP ORDER Parameter)
   *
   * SUBSCRIBE では Subscriber の希望値として Message Parameter で使用。
   * Publisher の GROUP_ORDER_PREFERENCE は Track Property として使用。
   * draft-ietf-moq-transport-18 Section 10.2 (Message Parameters)
   */
  GROUP_ORDER: 0x22,
  /**
   * NEW_GROUP_REQUEST (Section 10.2.13 NEW GROUP REQUEST Parameter)
   */
  NEW_GROUP_REQUEST: 0x32,
  /**
   * TRACK_NAMESPACE_PREFIX (Section 10.2.14 TRACK_NAMESPACE_PREFIX Parameter)
   *
   * draft-ietf-moq-transport-18:
   * REQUEST_UPDATE で SUBSCRIBE_NAMESPACE または SUBSCRIBE_TRACKS の
   * Track Namespace Prefix を更新するために使用する。
   * 値は Track Namespace エンコーディング。
   * draft-ietf-moq-transport-18 Section 10.2.14
   */
  TRACK_NAMESPACE_PREFIX: 0x34,
} as const;

export type MessageParameterType = (typeof MessageParameterType)[keyof typeof MessageParameterType];

/**
 * Group Order (Section 10.2.8 GROUP ORDER Parameter)
 */
export const GroupOrder = {
  ASCENDING: 0x01,
  DESCENDING: 0x02,
} as const;

export type GroupOrder = (typeof GroupOrder)[keyof typeof GroupOrder];

/**
 * Location Filter Types (Section 5.1.2 Location Filters)
 */
export const FilterType = {
  NEXT_GROUP_START: 0x01,
  LARGEST_OBJECT: 0x02,
  ABSOLUTE_START: 0x03,
  ABSOLUTE_RANGE: 0x04,
} as const;

export type FilterType = (typeof FilterType)[keyof typeof FilterType];

/**
 * Object Status (Section 11.2.1.1 Object Status)
 *
 * draft-ietf-moq-transport-18:
 * - 0x0: Normal object
 * - 0x3: End of Group (EOG)
 *   Indicates that no objects with the specified Group ID and the Object ID
 *   that is greater than or equal to the one specified exist.
 * - 0x4: End of Track (EOT)
 *   Indicates that no objects with the location that is equal to or greater
 *   than the one specified exist.
 *
 * Note: 0x1 (Object Does Not Exist) was removed in draft-16.
 * draft-ietf-moq-transport-18 Section 11.2.1.1
 */
export const ObjectStatus = {
  NORMAL: 0x0,
  END_OF_GROUP: 0x3,
  END_OF_TRACK: 0x4,
} as const;

export type ObjectStatus = (typeof ObjectStatus)[keyof typeof ObjectStatus];

/**
 * PUBLISH_DONE Status Codes (Section 10.11 PUBLISH_DONE)
 *
 * draft-ietf-moq-transport-18:
 * - 0x0: INTERNAL_ERROR
 * - 0x1: UNAUTHORIZED
 * - 0x2: TRACK_ENDED
 * - 0x3: SUBSCRIPTION_ENDED
 * - 0x4: GOING_AWAY
 * - 0x5: TOO_FAR_BEHIND
 * - 0x6: EXPIRED
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
  TOO_FAR_BEHIND: 0x5,
  EXPIRED: 0x6,
  UPDATE_FAILED: 0x8,
  EXCESSIVE_LOAD: 0x9,
  MALFORMED_TRACK: 0x12,
} as const;

export type PublishDoneStatusCode =
  (typeof PublishDoneStatusCode)[keyof typeof PublishDoneStatusCode];

/**
 * PUBLISH_DONE の Status Code がエラー（アプリに Error として通知すべき）かどうか
 *
 * draft-ietf-moq-transport-18 Section 10.11 (PUBLISH_DONE):
 * INTERNAL_ERROR (0x0), UNAUTHORIZED (0x1), TOO_FAR_BEHIND (0x5), UPDATE_FAILED (0x8),
 * EXCESSIVE_LOAD (0x9), MALFORMED_TRACK (0x12) をエラーとみなす。
 * TRACK_ENDED (0x2) 等はエラーとみなさない。
 * https://www.ietf.org/archive/id/draft-ietf-moq-transport-18.html#section-10.11
 */
export function isPublishDoneErrorStatus(statusCode: bigint): boolean {
  switch (statusCode) {
    case 0x0n:
    case 0x1n:
    case 0x5n:
    case 0x8n:
    case 0x9n:
    case 0x12n:
      return true;
    default:
      return false;
  }
}

/**
 * Object Forwarding Preference (Section 11.2.1)
 *
 * draft-ietf-moq-transport-18:
 * "An enumeration indicating how a publisher sends an object.
 *  The preferences are Subgroup and Datagram."
 */
export const ObjectForwardingPreference = {
  SUBGROUP: 0x1,
  DATAGRAM: 0x2,
} as const;

export type ObjectForwardingPreference =
  (typeof ObjectForwardingPreference)[keyof typeof ObjectForwardingPreference];

/**
 * Location (Group ID, Object ID)
 */
export interface Location {
  group: bigint;
  object: bigint;
}
