/**
 * Parameter Scope 検証の単体テスト
 * draft-ietf-moq-transport-21 §9.20.1 (Parameter Scope) / §9.20.17 (EXPIRES Parameter)
 */

import { test, assert } from "vite-plus/test";
import {
  NAMESPACE_OK_ALLOWED_PARAMS,
  NAMESPACE_REQUEST_UPDATE_ALLOWED_PARAMS,
  PUBLISH_OK_ALLOWED_PARAMS,
  PUBLISH_ALLOWED_PARAMS,
  REQUEST_UPDATE_ALLOWED_PARAMS,
  REQUEST_UPDATE_OK_ALLOWED_PARAMS,
  TRACK_STATUS_OK_ALLOWED_PARAMS,
  SUBSCRIBE_OK_ALLOWED_PARAMS,
  FETCH_OK_ALLOWED_PARAMS,
  PUBLISH_STATE_NOTIFY_ALLOWED_PARAMS,
  assertParametersAllowedForSend,
  validateParameterScope,
} from "./parameterScope";
import { MessageParameterType } from "./types";
import { SessionError, SessionErrorCode } from "../error";

/**
 * 検証違反の戻り値が PROTOCOL_VIOLATION の SessionError であることを検証する
 *
 * expectedMessage を指定した場合はエラーメッセージも検証する。
 */
function assertProtocolViolation(error: SessionError | null, expectedMessage?: string): void {
  if (error === null) {
    assert.fail("PROTOCOL_VIOLATION の SessionError を期待したが null だった");
  }
  assert.equal(error.code, SessionErrorCode.PROTOCOL_VIOLATION);
  if (expectedMessage !== undefined) {
    assert.equal(error.message, expectedMessage);
  }
}

/**
 * draft-ietf-moq-transport-21 §9.20.17:
 * EXPIRES は SUBSCRIBE_NAMESPACE_OK / SUBSCRIBE_TRACKS_OK / PUBLISH_NAMESPACE_OK で許可される。
 * NAMESPACE_OK_ALLOWED_PARAMS が EXPIRES のみを含むことを検証する。
 */
test("NAMESPACE_OK_ALLOWED_PARAMS は EXPIRES のみを含む", () => {
  assert.isTrue(NAMESPACE_OK_ALLOWED_PARAMS.has(MessageParameterType.EXPIRES));
  assert.equal(NAMESPACE_OK_ALLOWED_PARAMS.size, 1);
});

/**
 * draft-ietf-moq-transport-21 §9.20.1:
 * 許可パラメータ集合に含まれるパラメータは検証を通過する。
 * EXPIRES のみを含むパラメータ配列が NAMESPACE_OK_ALLOWED_PARAMS で通過することを検証する。
 */
test("EXPIRES パラメータは NAMESPACE_OK_ALLOWED_PARAMS で検証を通過する", () => {
  const error = validateParameterScope(
    [{ type: MessageParameterType.EXPIRES }],
    NAMESPACE_OK_ALLOWED_PARAMS,
    "SUBSCRIBE_NAMESPACE_OK",
  );
  assert.isNull(error);
});

/**
 * 空パラメータ配列は常に検証を通過する。
 */
test("空パラメータ配列は NAMESPACE_OK_ALLOWED_PARAMS で検証を通過する", () => {
  const error = validateParameterScope([], NAMESPACE_OK_ALLOWED_PARAMS, "SUBSCRIBE_TRACKS_OK");
  assert.isNull(error);
});

/**
 * draft-ietf-moq-transport-21 §9.20.1:
 * "Each Message Parameter definition indicates the message types in which
 *  it can appear. If it appears in some other type of message, the receiving
 *  endpoint MUST close the connection with a PROTOCOL_VIOLATION."
 * 許可外パラメータが PROTOCOL_VIOLATION の SessionError を返すことを検証する。
 */
test("許可外パラメータは PROTOCOL_VIOLATION のエラーを返す", () => {
  const error = validateParameterScope(
    [{ type: MessageParameterType.LARGEST_OBJECT }],
    NAMESPACE_OK_ALLOWED_PARAMS,
    "PUBLISH_NAMESPACE_OK",
  );
  assertProtocolViolation(error, "parameter type 0x9 not allowed in PUBLISH_NAMESPACE_OK");
});

/**
 * 複数パラメータのうち 1 つでも許可外が含まれれば PROTOCOL_VIOLATION になる。
 */
test("EXPIRES + 許可外パラメータの混合は PROTOCOL_VIOLATION のエラーを返す", () => {
  const error = validateParameterScope(
    [{ type: MessageParameterType.EXPIRES }, { type: MessageParameterType.SUBSCRIBER_PRIORITY }],
    NAMESPACE_OK_ALLOWED_PARAMS,
    "SUBSCRIBE_NAMESPACE_OK",
  );
  assertProtocolViolation(error);
});

// ============================================================================
// PUBLISH_OK_ALLOWED_PARAMS のテスト
// ============================================================================

/**
 * draft-ietf-moq-transport-21 §9.20.17:
 * EXPIRES のみが PUBLISH_OK に出現できる。
 * PUBLISH_OK_ALLOWED_PARAMS が EXPIRES のみを含むことを検証する。
 */
test("PUBLISH_OK_ALLOWED_PARAMS は EXPIRES のみを含む", () => {
  assert.isTrue(PUBLISH_OK_ALLOWED_PARAMS.has(MessageParameterType.EXPIRES));
  assert.equal(PUBLISH_OK_ALLOWED_PARAMS.size, 1);
});

/**
 * draft-ietf-moq-transport-21 §9.20.17 / §9.20.1:
 * Subscription Parameters は PUBLISH_OK に出現できない。
 * GROUP_ORDER / FORWARD / LOCATION_FILTER 等がスコープ検証で拒否されることを検証する。
 */
test("PUBLISH_OK_ALLOWED_PARAMS は GROUP_ORDER を含まない", () => {
  assert.isFalse(PUBLISH_OK_ALLOWED_PARAMS.has(MessageParameterType.GROUP_ORDER));
});

/**
 * GROUP_ORDER 付き PUBLISH_OK はスコープ検証で拒否される。
 */
test("GROUP_ORDER 付き PUBLISH_OK は PROTOCOL_VIOLATION のエラーを返す", () => {
  const error = validateParameterScope(
    [{ type: MessageParameterType.GROUP_ORDER }],
    PUBLISH_OK_ALLOWED_PARAMS,
    "PUBLISH_OK",
  );
  assertProtocolViolation(error);
});

/**
 * draft-ietf-moq-transport-21 §9.20.17 / §9.20.1:
 * FORWARD / LOCATION_FILTER 等の Subscription Parameters は PUBLISH_OK に
 * 出現できない。代表として FORWARD / LOCATION_FILTER と Range Filter
 * (SUBGROUP_FILTER) がスコープ検証で拒否されることを検証する。
 */
test("Subscription Parameters 付き PUBLISH_OK は PROTOCOL_VIOLATION のエラーを返す", () => {
  for (const type of [
    MessageParameterType.FORWARD,
    MessageParameterType.LOCATION_FILTER,
    MessageParameterType.SUBSCRIBER_PRIORITY,
    MessageParameterType.NEW_GROUP_REQUEST,
    MessageParameterType.OBJECT_DELIVERY_TIMEOUT,
    MessageParameterType.SUBGROUP_DELIVERY_TIMEOUT,
    MessageParameterType.SUBGROUP_FILTER,
  ]) {
    const error = validateParameterScope([{ type }], PUBLISH_OK_ALLOWED_PARAMS, "PUBLISH_OK");
    assertProtocolViolation(error);
  }
});

/**
 * draft-ietf-moq-transport-21 §9.20.17:
 * EXPIRES 付き PUBLISH_OK はスコープ検証を通過する。
 */
test("EXPIRES 付き PUBLISH_OK は検証を通過する", () => {
  const error = validateParameterScope(
    [{ type: MessageParameterType.EXPIRES }],
    PUBLISH_OK_ALLOWED_PARAMS,
    "PUBLISH_OK",
  );
  assert.isNull(error);
});

// ============================================================================
// PUBLISH_ALLOWED_PARAMS のテスト
// ============================================================================

/**
 * draft-ietf-moq-transport-21 §9.18.1:
 * SUBSCRIBE_TRACKS の結果 PUBLISH に GROUP_ORDER が載るため許可する。
 */
test("PUBLISH_ALLOWED_PARAMS は GROUP_ORDER を含む", () => {
  assert.isTrue(PUBLISH_ALLOWED_PARAMS.has(MessageParameterType.GROUP_ORDER));
});

/**
 * GROUP_ORDER 付き PUBLISH はスコープ検証で受理される。
 */
test("GROUP_ORDER 付き PUBLISH は検証を通過する", () => {
  const error = validateParameterScope(
    [{ type: MessageParameterType.GROUP_ORDER }],
    PUBLISH_ALLOWED_PARAMS,
    "PUBLISH",
  );
  assert.isNull(error);
});

/**
 * draft-ietf-moq-transport-21 §9.8:
 * PUBLISH は初期 Subscription Parameters として FORWARD / GROUP_ORDER /
 * SUBSCRIBER_PRIORITY / SUBGROUP_DELIVERY_TIMEOUT / OBJECT_DELIVERY_TIMEOUT /
 * LOCATION_FILTER を運べる。既存 5 種に加えた 4 種が許可されることを検証する。
 */
test("PUBLISH_ALLOWED_PARAMS は Subscription Parameters 4 種を含む", () => {
  assert.isTrue(PUBLISH_ALLOWED_PARAMS.has(MessageParameterType.OBJECT_DELIVERY_TIMEOUT));
  assert.isTrue(PUBLISH_ALLOWED_PARAMS.has(MessageParameterType.SUBGROUP_DELIVERY_TIMEOUT));
  assert.isTrue(PUBLISH_ALLOWED_PARAMS.has(MessageParameterType.SUBSCRIBER_PRIORITY));
  assert.isTrue(PUBLISH_ALLOWED_PARAMS.has(MessageParameterType.LOCATION_FILTER));
  assert.equal(PUBLISH_ALLOWED_PARAMS.size, 9);
});

/**
 * draft-ietf-moq-transport-21 §9.8:
 * 新規 4 種付き PUBLISH はいずれもスコープ検証を通過する。
 */
test("Subscription Parameters 付き PUBLISH は検証を通過する", () => {
  for (const type of [
    MessageParameterType.OBJECT_DELIVERY_TIMEOUT,
    MessageParameterType.SUBGROUP_DELIVERY_TIMEOUT,
    MessageParameterType.SUBSCRIBER_PRIORITY,
    MessageParameterType.LOCATION_FILTER,
  ]) {
    const error = validateParameterScope([{ type }], PUBLISH_ALLOWED_PARAMS, "PUBLISH");
    assert.isNull(error);
  }
});

/**
 * draft-ietf-moq-transport-21 §9.8:
 * NEW_GROUP_REQUEST / Range Filters / FILL_PARAMETERS は PUBLISH に
 * 出現できない。スコープ検証で拒否されることを検証する。
 */
test("PUBLISH に許可されないパラメータは PROTOCOL_VIOLATION のエラーを返す", () => {
  for (const type of [
    MessageParameterType.NEW_GROUP_REQUEST,
    MessageParameterType.SUBGROUP_FILTER,
    MessageParameterType.OBJECTID_FILTER,
    MessageParameterType.PRIORITY_FILTER,
    MessageParameterType.OBJECT_PROPERTY_FILTER,
    MessageParameterType.TRACK_PROPERTY_FILTER,
    MessageParameterType.FILL_PARAMETERS,
  ]) {
    const error = validateParameterScope([{ type }], PUBLISH_ALLOWED_PARAMS, "PUBLISH");
    assertProtocolViolation(error);
  }
});

/**
 * draft-ietf-moq-transport-21 §9.20.22 / §9.20.1:
 * INCLUDE_PROPERTIES (0x35) は SUBSCRIBE / TRACK_STATUS / FETCH /
 * SUBSCRIBE_TRACKS にのみ出現でき、応答側の許可集合には含まれない。
 * 応答文脈への混入は PROTOCOL_VIOLATION で拒否されることを検証する。
 */
test("INCLUDE_PROPERTIES の応答への混入は PROTOCOL_VIOLATION のエラーを返す", () => {
  for (const allowed of [
    NAMESPACE_OK_ALLOWED_PARAMS,
    PUBLISH_OK_ALLOWED_PARAMS,
    REQUEST_UPDATE_OK_ALLOWED_PARAMS,
    TRACK_STATUS_OK_ALLOWED_PARAMS,
    SUBSCRIBE_OK_ALLOWED_PARAMS,
    FETCH_OK_ALLOWED_PARAMS,
    PUBLISH_STATE_NOTIFY_ALLOWED_PARAMS,
  ]) {
    const error = validateParameterScope(
      [{ type: MessageParameterType.INCLUDE_PROPERTIES }],
      allowed,
      "RESPONSE",
    );
    assertProtocolViolation(error);
  }
});

// ============================================================================
// REQUEST_UPDATE_ALLOWED_PARAMS のテスト
// ============================================================================

/**
 * draft-ietf-moq-transport-21 §9.20.21 / §9.20.1:
 * TRACK_NAMESPACE_PREFIX は namespace 系 (SUBSCRIBE_NAMESPACE /
 * SUBSCRIBE_TRACKS) の REQUEST_UPDATE にのみ出現できる。
 * subscription 系 REQUEST_UPDATE の許可集合には含まれないことを検証する。
 */
test("REQUEST_UPDATE_ALLOWED_PARAMS は TRACK_NAMESPACE_PREFIX を含まない", () => {
  assert.isFalse(REQUEST_UPDATE_ALLOWED_PARAMS.has(MessageParameterType.TRACK_NAMESPACE_PREFIX));
});

/**
 * draft-ietf-moq-transport-21 §9.20.9 / §9.20.17:
 * GROUP_ORDER と EXPIRES は REQUEST_UPDATE に出現できない。
 */
test("REQUEST_UPDATE_ALLOWED_PARAMS は GROUP_ORDER / EXPIRES を含まない", () => {
  assert.isFalse(REQUEST_UPDATE_ALLOWED_PARAMS.has(MessageParameterType.GROUP_ORDER));
  assert.isFalse(REQUEST_UPDATE_ALLOWED_PARAMS.has(MessageParameterType.EXPIRES));
});

/**
 * draft-ietf-moq-transport-21 §3.3.2:
 * TRACK_PROPERTY_FILTER は SUBSCRIBE_TRACKS とその REQUEST_UPDATE にのみ
 * 出現できる。subscription 系 REQUEST_UPDATE の許可集合には含まれない。
 */
test("REQUEST_UPDATE_ALLOWED_PARAMS は TRACK_PROPERTY_FILTER を含まない", () => {
  assert.isFalse(REQUEST_UPDATE_ALLOWED_PARAMS.has(MessageParameterType.TRACK_PROPERTY_FILTER));
});

/**
 * draft-ietf-moq-transport-21 §9.20.8 / §9.20.10 / §9.20.20 / §9.20.16 / §3.3.2:
 * SUBSCRIBER_PRIORITY / LOCATION_FILTER / NEW_GROUP_REQUEST / FILL_PARAMETERS /
 * Range Filters (0x25-0x28) は subscription 系 REQUEST_UPDATE に出現できる。
 */
test("REQUEST_UPDATE_ALLOWED_PARAMS は subscription 系の許可パラメータを含む", () => {
  for (const type of [
    MessageParameterType.AUTHORIZATION_TOKEN,
    MessageParameterType.OBJECT_DELIVERY_TIMEOUT,
    MessageParameterType.SUBGROUP_DELIVERY_TIMEOUT,
    MessageParameterType.SUBSCRIBER_PRIORITY,
    MessageParameterType.FORWARD,
    MessageParameterType.LOCATION_FILTER,
    MessageParameterType.NEW_GROUP_REQUEST,
    MessageParameterType.FILL_PARAMETERS,
    MessageParameterType.SUBGROUP_FILTER,
    MessageParameterType.OBJECTID_FILTER,
    MessageParameterType.PRIORITY_FILTER,
    MessageParameterType.OBJECT_PROPERTY_FILTER,
  ]) {
    assert.isTrue(REQUEST_UPDATE_ALLOWED_PARAMS.has(type));
  }
});

/**
 * draft-ietf-moq-transport-21 §9.20.21 / §9.20.1:
 * TRACK_NAMESPACE_PREFIX を subscription 系 REQUEST_UPDATE のスコープ検証に
 * かけると PROTOCOL_VIOLATION の SessionError が返ることを検証する。
 */
test("TRACK_NAMESPACE_PREFIX 付き subscription 系 REQUEST_UPDATE は PROTOCOL_VIOLATION のエラーを返す", () => {
  const error = validateParameterScope(
    [{ type: MessageParameterType.TRACK_NAMESPACE_PREFIX }],
    REQUEST_UPDATE_ALLOWED_PARAMS,
    "REQUEST_UPDATE",
  );
  assertProtocolViolation(error);
});

/**
 * draft-ietf-moq-transport-21 §9.20.21:
 * NAMESPACE_REQUEST_UPDATE_ALLOWED_PARAMS は TRACK_NAMESPACE_PREFIX を含む。
 */
test("NAMESPACE_REQUEST_UPDATE_ALLOWED_PARAMS は TRACK_NAMESPACE_PREFIX を含む", () => {
  assert.isTrue(
    NAMESPACE_REQUEST_UPDATE_ALLOWED_PARAMS.has(MessageParameterType.TRACK_NAMESPACE_PREFIX),
  );
});

/**
 * 送信前検証: 許可集合に無い型は throw し、許可済みの型は通過することを検証する。
 */
test("assertParametersAllowedForSend: 許可外の型は throw し許可済みは通過する", () => {
  assert.doesNotThrow(() =>
    assertParametersAllowedForSend(
      [{ type: MessageParameterType.SUBSCRIBER_PRIORITY }],
      REQUEST_UPDATE_ALLOWED_PARAMS,
      "REQUEST_UPDATE",
    ),
  );
  assert.throws(
    () =>
      assertParametersAllowedForSend(
        [{ type: MessageParameterType.EXPIRES }],
        REQUEST_UPDATE_ALLOWED_PARAMS,
        "REQUEST_UPDATE",
      ),
    /not allowed in REQUEST_UPDATE/,
  );
});
