/**
 * MOQT Message Types
 * draft-ietf-moq-transport-15 Section 9
 */

/**
 * Message Types (Section 9)
 */
export const MessageType = {
  // Setup
  CLIENT_SETUP: 0x20,
  SERVER_SETUP: 0x21,

  // Session
  GOAWAY: 0x10,
  MAX_REQUEST_ID: 0x15,
  REQUESTS_BLOCKED: 0x1a,

  // Request/Response
  REQUEST_OK: 0x07,
  REQUEST_ERROR: 0x05,

  // Subscribe
  SUBSCRIBE: 0x03,
  SUBSCRIBE_OK: 0x04,
  SUBSCRIBE_UPDATE: 0x02,
  UNSUBSCRIBE: 0x0a,

  // Publish
  PUBLISH: 0x1d,
  PUBLISH_OK: 0x1e,
  PUBLISH_DONE: 0x0b,

  // Fetch
  FETCH: 0x16,
  FETCH_OK: 0x18,
  FETCH_CANCEL: 0x17,

  // Track Status
  TRACK_STATUS: 0x0d,

  // Namespace
  PUBLISH_NAMESPACE: 0x06,
  PUBLISH_NAMESPACE_DONE: 0x09,
  PUBLISH_NAMESPACE_CANCEL: 0x0c,
  SUBSCRIBE_NAMESPACE: 0x11,
  UNSUBSCRIBE_NAMESPACE: 0x14,
} as const;

export type MessageType = (typeof MessageType)[keyof typeof MessageType];

/**
 * Setup Parameter Types (Section 9.3.1)
 */
export const SetupParameterType = {
  PATH: 0x01,
  MAX_REQUEST_ID: 0x02,
  MAX_AUTH_TOKEN_CACHE_SIZE: 0x04,
  AUTHORITY: 0x05,
  MOQT_IMPLEMENTATION: 0x07,
} as const;

export type SetupParameterType = (typeof SetupParameterType)[keyof typeof SetupParameterType];

/**
 * Version Specific Parameter Types (Section 9.2.1)
 */
export const VersionSpecificParameterType = {
  AUTHORIZATION_TOKEN: 0x03,
  DELIVERY_TIMEOUT: 0x02,
  MAX_CACHE_DURATION: 0x04,
  EXPIRES: 0x08,
  LARGEST_OBJECT: 0x09,
  PUBLISHER_PRIORITY: 0x0e,
  FORWARD: 0x10,
  SUBSCRIBER_PRIORITY: 0x20,
  SUBSCRIPTION_FILTER: 0x21,
  GROUP_ORDER: 0x22,
  DYNAMIC_GROUPS: 0x30,
  NEW_GROUP_REQUEST: 0x32,
} as const;

export type VersionSpecificParameterType =
  (typeof VersionSpecificParameterType)[keyof typeof VersionSpecificParameterType];

/**
 * Group Order (Section 9.2.1.10)
 */
export const GroupOrder = {
  ASCENDING: 0x01,
  DESCENDING: 0x02,
} as const;

export type GroupOrder = (typeof GroupOrder)[keyof typeof GroupOrder];

/**
 * Subscription Filter Types (Section 5.1.2)
 */
export const FilterType = {
  NEXT_GROUP_START: 0x01,
  LARGEST_OBJECT: 0x02,
  ABSOLUTE_START: 0x03,
  ABSOLUTE_RANGE: 0x04,
} as const;

export type FilterType = (typeof FilterType)[keyof typeof FilterType];

/**
 * Object Status (Section 10.2.1.1)
 *
 * draft-ietf-moq-transport-15:
 * - 0x0: Normal object
 * - 0x1: Object Does Not Exist
 * - 0x3: End of Group
 * - 0x4: End of Track
 *
 * Note: 0x2 is not defined in the spec.
 */
export const ObjectStatus = {
  NORMAL: 0x0,
  OBJECT_DOES_NOT_EXIST: 0x1,
  END_OF_GROUP: 0x3,
  END_OF_TRACK: 0x4,
} as const;

export type ObjectStatus = (typeof ObjectStatus)[keyof typeof ObjectStatus];

/**
 * PUBLISH_DONE Status Codes (Section 9.15)
 *
 * draft-ietf-moq-transport-15:
 * - 0x0: INTERNAL_ERROR - An implementation specific or generic error occurred.
 * - 0x1: UNAUTHORIZED - The subscriber is no longer authorized to subscribe to the given track.
 * - 0x2: TRACK_ENDED - The track is no longer being published.
 * - 0x3: SUBSCRIPTION_ENDED - The publisher reached the end of a subscription filter range.
 * - 0x4: GOING_AWAY - The subscriber or publisher issued a GOAWAY message.
 * - 0x5: EXPIRED - The publisher reached the timeout specified in SUBSCRIBE_OK.
 * - 0x6: TOO_FAR_BEHIND - The publisher's queue of objects exceeds its limit.
 * - 0x7: MALFORMED_TRACK - A relay publisher detected the track was malformed.
 * - 0x8: UPDATE_FAILED - SUBSCRIBE_UPDATE failed on this subscription.
 */
export const PublishDoneStatusCode = {
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

export type PublishDoneStatusCode =
  (typeof PublishDoneStatusCode)[keyof typeof PublishDoneStatusCode];

/**
 * Location (Group ID, Object ID)
 */
export interface Location {
  group: bigint;
  object: bigint;
}
