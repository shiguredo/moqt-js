/**
 * MOQT Message Types
 * draft-ietf-moq-transport-23 Section 9 (Control Messages)
 */

/**
 * Message Types (Section 9 Control Messages)
 */
export const MessageType = {
  // draft-ietf-moq-transport-23 Section 9.1
  SETUP: 0x2f00,

  // セッション
  GOAWAY: 0x10,

  // リクエスト/レスポンス
  REQUEST_OK: 0x07,
  REQUEST_ERROR: 0x05,
  REQUEST_UPDATE: 0x02,

  /**
   * PUBLISH_STATE_NOTIFY (Section 9.10 PUBLISH_STATE_NOTIFY)
   *
   * draft-ietf-moq-transport-23:
   * publisher が subscription の bidi ストリーム上で送る片方向の状態通知。
   * 応答なし。購読以外の文脈・subscriber 発での受信は PROTOCOL_VIOLATION。
   */
  PUBLISH_STATE_NOTIFY: 0x22,

  // Subscribe
  SUBSCRIBE: 0x03,
  SUBSCRIBE_OK: 0x04,

  // Publish
  PUBLISH: 0x1d,
  PUBLISH_DONE: 0x0b,

  // Fetch
  FETCH: 0x16,
  // 0x18 は draft-ietf-moq-transport-23 §9 Table 5 で RESERVED (FETCH_OK in <= 22)。
  // FETCH の成功応答は REQUEST_OK (0x07) に統合され、旧 FETCH_OK の End Of Track /
  // End Location フィールドは削除された (Appendix A.1)。0x18 を受信した場合は
  // 未知のメッセージ型として扱う (旧版との自動判別は行わない)。

  // トラックステータス
  TRACK_STATUS: 0x0d,

  // Namespace
  PUBLISH_NAMESPACE: 0x06,
  NAMESPACE: 0x08,
  NAMESPACE_DONE: 0x0e,
  /**
   * PUBLISH_SKIPPED (Section 9.19 PUBLISH_SKIPPED)
   *
   * draft-ietf-moq-transport-23 Section 9.19 (PUBLISH_SKIPPED):
   * Publisher が Track に対する PUBLISH を送信しないことを示す。
   * SUBSCRIBE_TRACKS の応答ストリーム上で送信される。
   * draft-ietf-moq-transport-23 Section 3.6.3: "or any other reason"
   */
  PUBLISH_SKIPPED: 0x0f,
  /**
   * SUBSCRIBE_NAMESPACE (Section 9.15 SUBSCRIBE_NAMESPACE)
   *
   * draft-ietf-moq-transport-23:
   * namespace discovery (NAMESPACE / NAMESPACE_DONE 受信) を担当する。
   * draft-ietf-moq-transport-23 Section 9.15
   */
  SUBSCRIBE_NAMESPACE: 0x50,
  /**
   * SUBSCRIBE_TRACKS (Section 9.18 SUBSCRIBE_TRACKS)
   *
   * draft-ietf-moq-transport-23 §3.6:
   * track subscription (PUBLISH メッセージは新規 bidi で到着、
   * PUBLISH_SKIPPED は応答ストリーム上で到着) を担当する。
   * メッセージの定義は §9.18 である。
   */
  SUBSCRIBE_TRACKS: 0x51,
} as const;

export type MessageType = (typeof MessageType)[keyof typeof MessageType];

/**
 * MAX_CONTROL_MESSAGE_SIZE の既定値 (バイト)
 *
 * draft-ietf-moq-transport-23 §9.1.8:
 * 制御メッセージの Message Length (本文長) の上限。SETUP Option 0x09 を
 * 送らない場合はこの値を既定値として扱い、広告してよい値の最小値も同じ 65535 である。
 */
export const DEFAULT_MAX_CONTROL_MESSAGE_SIZE = 65535;

/**
 * MAX_CONTROL_MESSAGE_SIZE の最小値 (バイト)
 *
 * draft-ietf-moq-transport-23 §9.1.8: 広告してよい値の下限は 65535 であり、
 * 省略時の既定値と同じ値である。仕様で両者が同じ値と定められているため、
 * ずれないよう既定値から導出する。
 */
export const MIN_MAX_CONTROL_MESSAGE_SIZE = DEFAULT_MAX_CONTROL_MESSAGE_SIZE;

/**
 * Setup Option Types (Section 9.1 Setup Options)
 *
 * draft-ietf-moq-transport-23 §9.1, §16.4 (IANA registry)
 *
 * draft-ietf-moq-transport-23 §13 (Grease):
 * "Setup Options with reserved identifiers have no semantics and can
 *  carry arbitrary values. Endpoints MUST ignore unknown Setup Options."
 */
export const SetupOptionType = {
  PATH: 0x01,
  /**
   * AUTHORIZATION_TOKEN (Section 9.1.4 AUTHORIZATION TOKEN Setup Option)
   *
   * draft-ietf-moq-transport-23:
   * SETUP で送出する認証トークン。値は Section 8.9 の Token 構造。
   * SETUP では Alias Type DELETE / USE_ALIAS は禁止（Section 9.1.4）。
   */
  AUTHORIZATION_TOKEN: 0x03,
  MAX_AUTH_TOKEN_CACHE_SIZE: 0x04,
  AUTHORITY: 0x05,
  MOQT_IMPLEMENTATION: 0x07,
  /**
   * MAX_REQUEST_UPDATES (Section 9.1.7)
   *
   * draft-ietf-moq-transport-23:
   * リクエストストリームごとの未応答 REQUEST_UPDATE の最大数。
   * 0 は無制限。欠落時のデフォルトも 0。
   */
  MAX_REQUEST_UPDATES: 0x08,
  /**
   * MAX_FILTER_RANGES (Section 9.1.6)
   *
   * draft-ietf-moq-transport-23:
   * ピアが送信可能な Range Filter の最大数。デフォルト 0（送信禁止）。
   */
  MAX_FILTER_RANGES: 0x06,
  /**
   * MAX_CONTROL_MESSAGE_SIZE (Section 9.1.8)
   *
   * draft-ietf-moq-transport-23 §9.1.8:
   * 自 endpoint が受信を許す制御メッセージの Message Length (本文長) の上限。
   * 値は vi64 で符号化し、65535 未満は仕様違反である。省略時の既定値も 65535。
   */
  MAX_CONTROL_MESSAGE_SIZE: 0x09,
} as const;

export type SetupOptionType = (typeof SetupOptionType)[keyof typeof SetupOptionType];

/**
 * Message Parameter Types (Section 9.19 Message Parameters)
 *
 * draft-ietf-moq-transport-23:
 * - Message Parameters は単一ホップにスコープされる
 * - 全ての Message Parameters は理解されなければならない（未知のものはエラー）
 * - MAX_CACHE_DURATION / DEFAULT_PUBLISHER_PRIORITY / DEFAULT_PUBLISHER_GROUP_ORDER /
 *   DYNAMIC_GROUPS は Track Properties でのみ使用する
 * - OBJECT_DELIVERY_TIMEOUT / SUBGROUP_DELIVERY_TIMEOUT は Track Properties と
 *   Message Parameters の両方に出現する (§5.2: publisher は Track Property として、
 *   subscriber は Message Parameter として同じタイムアウトを伝える)
 * draft-ietf-moq-transport-23 Section 9.19 (Message Parameters)
 *
 * 注意: SUBSCRIBE / PUBLISH / REQUEST_UPDATE では OBJECT_DELIVERY_TIMEOUT と
 * SUBGROUP_DELIVERY_TIMEOUT が Message Parameter として出現する (Subscriber の希望値)。
 * GROUP_ORDER は SUBSCRIBE / PUBLISH / SUBSCRIBE_TRACKS / FETCH / FILL_PARAMETERS
 * に出現する。
 */
export const MessageParameterType = {
  /**
   * OBJECT_DELIVERY_TIMEOUT (Section 9.19.4 OBJECT_DELIVERY_TIMEOUT Parameter)
   *
   * draft-ietf-moq-transport-23 §9.19.4:
   * SUBSCRIBE / PUBLISH / REQUEST_UPDATE に出現可能。
   * Subscriber の希望値として Message Parameter で伝え、publisher は
   * Track Property として同じタイムアウトを伝える (§5.2)。
   */
  OBJECT_DELIVERY_TIMEOUT: 0x02,
  /**
   * AUTHORIZATION TOKEN (Section 9.19.2 AUTHORIZATION TOKEN Parameter)
   */
  AUTHORIZATION_TOKEN: 0x03,
  /**
   * RENDEZVOUS_TIMEOUT (Section 9.19.6 RENDEZVOUS TIMEOUT Parameter)
   *
   * draft-ietf-moq-transport-23:
   * SUBSCRIBE メッセージで使用。
   * リレーが Publisher を待つ時間（ミリ秒）。
   * 0 は即時応答を要求。不在の場合のデフォルト値は 0。
   * draft-ietf-moq-transport-23 Section 9.19.6
   */
  RENDEZVOUS_TIMEOUT: 0x04,
  /**
   * SUBGROUP_DELIVERY_TIMEOUT (Section 9.19.3 SUBGROUP_DELIVERY_TIMEOUT Parameter)
   *
   * draft-ietf-moq-transport-23:
   * SUBGROUP_DELIVERY_TIMEOUT パラメータは varint。
   * SUBSCRIBE / PUBLISH / REQUEST_UPDATE に出現可能。
   * 単位はミリ秒。0 はタイムアウトなしを意味する。
   * draft-ietf-moq-transport-23 Section 9.19.3
   */
  SUBGROUP_DELIVERY_TIMEOUT: 0x06,
  /**
   * EXPIRES (Section 9.19.16 EXPIRES Parameter)
   */
  EXPIRES: 0x08,
  /**
   * LARGEST_OBJECT (Section 9.19.17 LARGEST OBJECT Parameter)
   */
  LARGEST_OBJECT: 0x09,
  /**
   * FILL_TIMEOUT (Section 9.19.5 FILL TIMEOUT Parameter)
   *
   * FETCH メッセージで使用。
   * relay が欠損 object の fill 待機に費やす最大時間（ミリ秒）。
   * 0 は即座に利用可能な object のみを要求。
   */
  FILL_TIMEOUT: 0x0a,
  /**
   * PAUSED (draft-ietf-moq-transport-23 Section 9.19.18 PAUSED Parameter)
   *
   * draft-ietf-moq-transport-23 §9.19.18:
   * uint8。0 = unpaused (オブジェクトを送る)、1 = paused (送らない)。
   * SUBSCRIBE / REQUEST_UPDATE (for a subscription or a SUBSCRIBE_TRACKS request) /
   * PUBLISH / SUBSCRIBE_TRACKS / PUBLISH_STATE_NOTIFY に出現可能。
   * REQUEST_UPDATE と PUBLISH_STATE_NOTIFY で省略した場合は状態維持、
   * それ以外のメッセージで省略した場合は既定値 0 (unpaused)。
   * 値域外を受信した endpoint は INVALID_PARAMETER でセッションを閉じる
   * (現行の受信経路は SessionErrorCode への変換都合で PROTOCOL_VIOLATION として扱う)。
   *
   * draft-22 の FORWARD (0x10) を置き換えた型であり、ID と値の意味が反転している
   * (draft-22 FORWARD: 1 = 転送する / draft-23 PAUSED: 1 = 停止)。
   */
  PAUSED: 0x11,
  /**
   * SUBSCRIBER_PRIORITY (Section 9.19.7 SUBSCRIBER PRIORITY Parameter)
   */
  SUBSCRIBER_PRIORITY: 0x20,
  /**
   * LOCATION_FILTER (draft-ietf-moq-transport-23 Section 9.19.9 LOCATION FILTER Parameter)
   */
  LOCATION_FILTER: 0x21,
  /**
   * GROUP_ORDER (Section 9.19.8 GROUP ORDER Parameter)
   *
   * SUBSCRIBE では Subscriber の希望値として Message Parameter で使用。
   * Publisher の DEFAULT_PUBLISHER_GROUP_ORDER は Track Property として使用。
   * draft-ietf-moq-transport-23 Section 10.5 (DEFAULT PUBLISHER GROUP ORDER)
   */
  GROUP_ORDER: 0x22,
  /**
   * FILL_PARAMETERS (draft-ietf-moq-transport-23 Section 9.19.15)
   *
   * draft-ietf-moq-transport-23 §9.19.15:
   * SUBSCRIBE / SUBSCRIBE_TRACKS / PUBLISH / REQUEST_UPDATE (for a subscription)
   * で fill fetch ストリームを要求する。値は Number of Parameters (vi64) +
   * その個数の Parameters の自己区切り構造で、外側 Length を持たない
   * (内側は別メッセージの Parameters として符号化する)。
   * 現行実装が送信に使うのは SUBSCRIBE と REQUEST_UPDATE であり、
   * SUBSCRIBE_TRACKS / PUBLISH での利用は受信側の許可集合と合わせて別途対応する。
   */
  FILL_PARAMETERS: 0x23,
  /**
   * NEW_GROUP_REQUEST (Section 9.19.19 NEW GROUP REQUEST Parameter)
   */
  NEW_GROUP_REQUEST: 0x32,
  /**
   * TRACK_NAMESPACE_PREFIX (Section 9.19.20 TRACK_NAMESPACE_PREFIX Parameter)
   *
   * draft-ietf-moq-transport-23:
   * REQUEST_UPDATE で SUBSCRIBE_NAMESPACE または SUBSCRIBE_TRACKS の
   * Track Namespace Prefix を更新するために使用する。
   * 値は §8.7 の Track Namespace エンコーディング (自己区切り) そのもので、
   * 外側 Length は付加しない。
   * draft-ietf-moq-transport-23 Section 9.19.20
   */
  TRACK_NAMESPACE_PREFIX: 0x34,
  /**
   * SUBGROUP_FILTER (Section 9.19.10 SUBGROUP FILTER Parameter)
   * draft-ietf-moq-transport-23: Range Filter の一種
   */
  SUBGROUP_FILTER: 0x25,
  /**
   * OBJECTID_FILTER (Section 9.19.11 OBJECTID FILTER Parameter)
   * draft-ietf-moq-transport-23: Range Filter の一種
   */
  OBJECTID_FILTER: 0x26,
  /**
   * PRIORITY_FILTER (Section 9.19.12 PRIORITY FILTER Parameter)
   * draft-ietf-moq-transport-23: Range Filter の一種
   */
  PRIORITY_FILTER: 0x27,
  /**
   * OBJECT_PROPERTY_FILTER (Section 9.19.13 OBJECT PROPERTY FILTER Parameter)
   * draft-ietf-moq-transport-23: Range Filter の一種。Property Type 付き
   */
  OBJECT_PROPERTY_FILTER: 0x28,
  /**
   * TRACK_PROPERTY_FILTER (Section 9.19.14 TRACK PROPERTY FILTER Parameter)
   * draft-ietf-moq-transport-23: Range Filter の一種。Property Type 付き。SUBSCRIBE_TRACKS 専用
   */
  TRACK_PROPERTY_FILTER: 0x29,
  /**
   * INCLUDE_PROPERTIES (Section 9.19.22 INCLUDE_PROPERTIES Parameter)
   *
   * draft-ietf-moq-transport-23:
   * 応答 / PUBLISH に Track Properties を載せるかを要求する uint8。
   * 0 (送らない) または 1 (送る)。デフォルト 1。
   * SUBSCRIBE / TRACK_STATUS / FETCH / SUBSCRIBE_TRACKS に出現可能。
   */
  INCLUDE_PROPERTIES: 0x35,
  /**
   * SUBSCRIBE_TRACKS_ID (draft-ietf-moq-transport-23 §9.19.21)
   *
   * draft-ietf-moq-transport-23 §9.19.21:
   * varint。SUBSCRIBE_TRACKS の結果として送信された PUBLISH にだけ出現し、
   * 元の SUBSCRIBE_TRACKS の Request ID を保持する。重なる複数の
   * SUBSCRIBE_TRACKS が同じ Track に一致した場合、publisher は要求ごとに
   * PUBLISH を送るため (§3.6)、受信側はこの値で callback とフィルタを
   * 対応する要求へ結び付ける。
   */
  SUBSCRIBE_TRACKS_ID: 0x36,
} as const;

export type MessageParameterType = (typeof MessageParameterType)[keyof typeof MessageParameterType];

/**
 * Group Order (Section 9.19.8 GROUP ORDER Parameter)
 */
export const GroupOrder = {
  ASCENDING: 0x01,
  DESCENDING: 0x02,
} as const;

export type GroupOrder = (typeof GroupOrder)[keyof typeof GroupOrder];

/**
 * Object Status (§11.1.1 Object Status)
 *
 * draft-ietf-moq-transport-23:
 * - 0x0: Normal object
 * - 0x3: End of Group (EOG)
 *   Indicates that no objects with the specified Group ID and the Object ID
 *   that is greater than or equal to the one specified exist.
 * - 0x4: End of Track (EOT)
 *   Indicates that no objects with the location that is equal to or greater
 *   than the one specified exist.
 *
 * draft-ietf-moq-transport-23 §11.1.1
 */
export const ObjectStatus = {
  NORMAL: 0x0,
  END_OF_GROUP: 0x3,
  END_OF_TRACK: 0x4,
} as const;

export type ObjectStatus = (typeof ObjectStatus)[keyof typeof ObjectStatus];

/**
 * PUBLISH_DONE Status Codes (Section 12.4 Publish Done Codes)
 *
 * draft-ietf-moq-transport-23:
 * - 0x0: INTERNAL_ERROR
 * - 0x1: UNAUTHORIZED
 * - 0x2: TRACK_ENDED
 * - 0x4: GOING_AWAY
 * - 0x5: TOO_FAR_BEHIND
 * - 0x6: EXPIRED
 * - 0x8: UPDATE_FAILED
 * - 0x9: EXCESSIVE_LOAD
 * - 0x12: MALFORMED_TRACK
 *
 * 0x3 SUBSCRIPTION_ENDED は draft-20 で削除された
 * (draft-ietf-moq-transport-23 §A.3)。Largest Object が Location Filter の
 * 終端を過ぎても購読は終わらない。
 */
export const PublishDoneStatusCode = {
  INTERNAL_ERROR: 0x0,
  UNAUTHORIZED: 0x1,
  TRACK_ENDED: 0x2,
  GOING_AWAY: 0x4,
  TOO_FAR_BEHIND: 0x5,
  EXPIRED: 0x6,
  /**
   * EXPIRED_AUTH_TOKEN (Section 12.4)
   *
   * 購読を認可したトークンの有効期限切れ。Session Termination の
   * EXPIRED_AUTH_TOKEN (0x18) / REQUEST_ERROR の 0x5 / Stream Reset の 0x7 とは
   * 文脈ごとに異なるコード空間であり、共通の数値・normalizer は使わない。
   */
  EXPIRED_AUTH_TOKEN: 0x7,
  UPDATE_FAILED: 0x8,
  EXCESSIVE_LOAD: 0x9,
  MALFORMED_TRACK: 0x12,
} as const;

export type PublishDoneStatusCode =
  (typeof PublishDoneStatusCode)[keyof typeof PublishDoneStatusCode];

/**
 * PUBLISH_DONE の Status Code がエラー（アプリにエラーとして扱うべき）かどうか
 *
 * draft-ietf-moq-transport-23 Section 9.9 (PUBLISH_DONE):
 * "The Status Code indicates why the subscription ended, and whether it was an error."
 * どの code がエラーかの判断は Section 12.4 (Publish Done Codes) の説明に基づく。
 * INTERNAL_ERROR (0x0), UNAUTHORIZED (0x1), TOO_FAR_BEHIND (0x5),
 * EXPIRED_AUTH_TOKEN (0x7), UPDATE_FAILED (0x8), EXCESSIVE_LOAD (0x9),
 * MALFORMED_TRACK (0x12) をエラーとみなす。
 * TRACK_ENDED (0x2), GOING_AWAY (0x4), EXPIRED (0x6) は購読の正常な終わりであり、
 * エラーとみなさない (§12.4 にエラーを示す記述が無い)。
 *
 * 列挙に無い値は、draft-ietf-moq-transport-23 §13 (Grease) の
 * "Receipt of an unknown error code in any error context (Session Termination, REQUEST_ERROR,
 * PUBLISH_DONE, or Data Stream Reset) MUST be treated as equivalent to INTERNAL_ERROR for that
 * context." に従い、エラーとみなす。受信経路は正規化 (normalizePublishDoneCode) を通るため、
 * 通常は列挙の値だけが渡る。
 */
export function isPublishDoneErrorStatus(statusCode: PublishDoneStatusCode): boolean {
  switch (statusCode) {
    case PublishDoneStatusCode.INTERNAL_ERROR:
    case PublishDoneStatusCode.UNAUTHORIZED:
    case PublishDoneStatusCode.TOO_FAR_BEHIND:
    case PublishDoneStatusCode.EXPIRED_AUTH_TOKEN:
    case PublishDoneStatusCode.UPDATE_FAILED:
    case PublishDoneStatusCode.EXCESSIVE_LOAD:
    case PublishDoneStatusCode.MALFORMED_TRACK:
      return true;
    case PublishDoneStatusCode.TRACK_ENDED:
    case PublishDoneStatusCode.GOING_AWAY:
    case PublishDoneStatusCode.EXPIRED:
      return false;
    default:
      return true;
  }
}

/**
 * Location (Group ID, Object ID)
 */
export interface Location {
  group: bigint;
  object: bigint;
}
