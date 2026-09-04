/**
 * Parameter Scope 検証の単体テスト
 * draft-ietf-moq-transport-19 §10.2.1 (Parameter Scope) / §10.2.15 (EXPIRES Parameter)
 */

import { test, assert } from "vite-plus/test";
import {
  NAMESPACE_OK_ALLOWED_PARAMS,
  PUBLISH_OK_ALLOWED_PARAMS,
  PUBLISH_ALLOWED_PARAMS,
  REQUEST_UPDATE_OK_ALLOWED_PARAMS,
  TRACK_STATUS_OK_ALLOWED_PARAMS,
  SUBSCRIBE_OK_ALLOWED_PARAMS,
  FETCH_OK_ALLOWED_PARAMS,
  PUBLISH_STATE_NOTIFY_ALLOWED_PARAMS,
  validateParameterScope,
} from "./parameterScope";
import { MessageParameterType } from "./types";
import { SessionError, SessionErrorCode } from "../error";

/**
 * draft-ietf-moq-transport-19 §10.2.15:
 * EXPIRES は SUBSCRIBE_NAMESPACE_OK / SUBSCRIBE_TRACKS_OK / PUBLISH_NAMESPACE_OK で許可される。
 * NAMESPACE_OK_ALLOWED_PARAMS が EXPIRES のみを含むことを検証する。
 */
test("NAMESPACE_OK_ALLOWED_PARAMS は EXPIRES のみを含む", () => {
  assert.isTrue(NAMESPACE_OK_ALLOWED_PARAMS.has(MessageParameterType.EXPIRES));
  assert.equal(NAMESPACE_OK_ALLOWED_PARAMS.size, 1);
});

/**
 * draft-ietf-moq-transport-19 §10.2.1:
 * 許可パラメータ集合に含まれるパラメータは検証を通過する。
 * EXPIRES のみを含むパラメータ配列が NAMESPACE_OK_ALLOWED_PARAMS で通過することを検証する。
 */
test("EXPIRES パラメータは NAMESPACE_OK_ALLOWED_PARAMS で検証を通過する", () => {
  let closed = false;
  const result = validateParameterScope(
    [{ type: MessageParameterType.EXPIRES }],
    NAMESPACE_OK_ALLOWED_PARAMS,
    "SUBSCRIBE_NAMESPACE_OK",
    () => {
      closed = true;
    },
  );
  assert.isTrue(result);
  assert.isFalse(closed);
});

/**
 * 空パラメータ配列は常に検証を通過する。
 */
test("空パラメータ配列は NAMESPACE_OK_ALLOWED_PARAMS で検証を通過する", () => {
  let closed = false;
  const result = validateParameterScope(
    [],
    NAMESPACE_OK_ALLOWED_PARAMS,
    "SUBSCRIBE_TRACKS_OK",
    () => {
      closed = true;
    },
  );
  assert.isTrue(result);
  assert.isFalse(closed);
});

/**
 * draft-ietf-moq-transport-19 §10.2.1:
 * "An endpoint that receives a parameter in a context where it is not
 *  allowed MUST close the session with a PROTOCOL_VIOLATION."
 * 許可外パラメータが PROTOCOL_VIOLATION でセッションを閉じることを検証する。
 */
test("許可外パラメータは PROTOCOL_VIOLATION でセッションを閉じる", () => {
  const errors: SessionError[] = [];
  const result = validateParameterScope(
    [{ type: MessageParameterType.LARGEST_OBJECT }],
    NAMESPACE_OK_ALLOWED_PARAMS,
    "PUBLISH_NAMESPACE_OK",
    (error) => {
      errors.push(error);
    },
  );
  assert.isFalse(result);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, SessionErrorCode.PROTOCOL_VIOLATION);
});

/**
 * 複数パラメータのうち 1 つでも許可外が含まれれば PROTOCOL_VIOLATION になる。
 */
test("EXPIRES + 許可外パラメータの混合は PROTOCOL_VIOLATION でセッションを閉じる", () => {
  const errors: SessionError[] = [];
  const result = validateParameterScope(
    [{ type: MessageParameterType.EXPIRES }, { type: MessageParameterType.SUBSCRIBER_PRIORITY }],
    NAMESPACE_OK_ALLOWED_PARAMS,
    "SUBSCRIBE_NAMESPACE_OK",
    (error) => {
      errors.push(error);
    },
  );
  assert.isFalse(result);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, SessionErrorCode.PROTOCOL_VIOLATION);
});

// ============================================================================
// PUBLISH_OK_ALLOWED_PARAMS のテスト
// ============================================================================

/**
 * draft-ietf-moq-transport-20 §10.2.16:
 * EXPIRES のみが PUBLISH_OK に出現できる。
 * PUBLISH_OK_ALLOWED_PARAMS が EXPIRES のみを含むことを検証する。
 */
test("PUBLISH_OK_ALLOWED_PARAMS は EXPIRES のみを含む", () => {
  assert.isTrue(PUBLISH_OK_ALLOWED_PARAMS.has(MessageParameterType.EXPIRES));
  assert.equal(PUBLISH_OK_ALLOWED_PARAMS.size, 1);
});

/**
 * draft-ietf-moq-transport-20 §10.2.16 / §10.2.1:
 * Subscription Parameters は PUBLISH_OK に出現できない。
 * GROUP_ORDER / FORWARD / LOCATION_FILTER 等がスコープ検証で拒否されることを検証する。
 */
test("PUBLISH_OK_ALLOWED_PARAMS は GROUP_ORDER を含まない", () => {
  assert.isFalse(PUBLISH_OK_ALLOWED_PARAMS.has(MessageParameterType.GROUP_ORDER));
});

/**
 * GROUP_ORDER 付き PUBLISH_OK はスコープ検証で拒否される。
 */
test("GROUP_ORDER 付き PUBLISH_OK は PROTOCOL_VIOLATION で拒否される", () => {
  const errors: SessionError[] = [];
  const result = validateParameterScope(
    [{ type: MessageParameterType.GROUP_ORDER }],
    PUBLISH_OK_ALLOWED_PARAMS,
    "PUBLISH_OK",
    (error) => {
      errors.push(error);
    },
  );
  assert.isFalse(result);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, SessionErrorCode.PROTOCOL_VIOLATION);
});

/**
 * draft-ietf-moq-transport-20 §10.2.16 / §10.2.1:
 * FORWARD / LOCATION_FILTER 等の Subscription Parameters は PUBLISH_OK に
 * 出現できない。代表として FORWARD / LOCATION_FILTER と Range Filter
 * (SUBGROUP_FILTER) がスコープ検証で拒否されることを検証する。
 */
test("Subscription Parameters 付き PUBLISH_OK は PROTOCOL_VIOLATION で拒否される", () => {
  for (const type of [
    MessageParameterType.FORWARD,
    MessageParameterType.LOCATION_FILTER,
    MessageParameterType.SUBSCRIBER_PRIORITY,
    MessageParameterType.NEW_GROUP_REQUEST,
    MessageParameterType.OBJECT_DELIVERY_TIMEOUT,
    MessageParameterType.SUBGROUP_DELIVERY_TIMEOUT,
    MessageParameterType.SUBGROUP_FILTER,
  ]) {
    const errors: SessionError[] = [];
    const result = validateParameterScope(
      [{ type }],
      PUBLISH_OK_ALLOWED_PARAMS,
      "PUBLISH_OK",
      (error) => {
        errors.push(error);
      },
    );
    assert.isFalse(result);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].code, SessionErrorCode.PROTOCOL_VIOLATION);
  }
});

/**
 * draft-ietf-moq-transport-20 §10.2.16:
 * EXPIRES 付き PUBLISH_OK はスコープ検証を通過する。
 */
test("EXPIRES 付き PUBLISH_OK は検証を通過する", () => {
  const errors: SessionError[] = [];
  const result = validateParameterScope(
    [{ type: MessageParameterType.EXPIRES }],
    PUBLISH_OK_ALLOWED_PARAMS,
    "PUBLISH_OK",
    (error) => {
      errors.push(error);
    },
  );
  assert.isTrue(result);
  assert.equal(errors.length, 0);
});

// ============================================================================
// PUBLISH_ALLOWED_PARAMS のテスト
// ============================================================================

/**
 * draft-ietf-moq-transport-19 §10.19.1:
 * SUBSCRIBE_TRACKS の結果 PUBLISH に GROUP_ORDER が載るため許可する。
 */
test("PUBLISH_ALLOWED_PARAMS は GROUP_ORDER を含む", () => {
  assert.isTrue(PUBLISH_ALLOWED_PARAMS.has(MessageParameterType.GROUP_ORDER));
});

/**
 * GROUP_ORDER 付き PUBLISH はスコープ検証で受理される。
 */
test("GROUP_ORDER 付き PUBLISH は検証を通過する", () => {
  const errors: SessionError[] = [];
  const result = validateParameterScope(
    [{ type: MessageParameterType.GROUP_ORDER }],
    PUBLISH_ALLOWED_PARAMS,
    "PUBLISH",
    (error) => {
      errors.push(error);
    },
  );
  assert.isTrue(result);
  assert.equal(errors.length, 0);
});

/**
 * draft-ietf-moq-transport-20 §10.11:
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
 * draft-ietf-moq-transport-20 §10.11:
 * 新規 4 種付き PUBLISH はいずれもスコープ検証を通過する。
 */
test("Subscription Parameters 付き PUBLISH は検証を通過する", () => {
  for (const type of [
    MessageParameterType.OBJECT_DELIVERY_TIMEOUT,
    MessageParameterType.SUBGROUP_DELIVERY_TIMEOUT,
    MessageParameterType.SUBSCRIBER_PRIORITY,
    MessageParameterType.LOCATION_FILTER,
  ]) {
    const errors: SessionError[] = [];
    const result = validateParameterScope(
      [{ type }],
      PUBLISH_ALLOWED_PARAMS,
      "PUBLISH",
      (error) => {
        errors.push(error);
      },
    );
    assert.isTrue(result);
    assert.equal(errors.length, 0);
  }
});

/**
 * draft-ietf-moq-transport-20 §10.11:
 * NEW_GROUP_REQUEST / Range Filters / FILL_PARAMETERS は PUBLISH に
 * 出現できない。スコープ検証で拒否されることを検証する。
 */
test("PUBLISH に許可されないパラメータは PROTOCOL_VIOLATION で拒否される", () => {
  for (const type of [
    MessageParameterType.NEW_GROUP_REQUEST,
    MessageParameterType.SUBGROUP_FILTER,
    MessageParameterType.OBJECTID_FILTER,
    MessageParameterType.PRIORITY_FILTER,
    MessageParameterType.OBJECT_PROPERTY_FILTER,
    MessageParameterType.TRACK_PROPERTY_FILTER,
    MessageParameterType.FILL_PARAMETERS,
  ]) {
    const errors: SessionError[] = [];
    const result = validateParameterScope(
      [{ type }],
      PUBLISH_ALLOWED_PARAMS,
      "PUBLISH",
      (error) => {
        errors.push(error);
      },
    );
    assert.isFalse(result);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].code, SessionErrorCode.PROTOCOL_VIOLATION);
  }
});

/**
 * draft-ietf-moq-transport-20 §10.2.21 / §10.2.1:
 * INCLUDE_PROPERTIES (0x35) は SUBSCRIBE / TRACK_STATUS / FETCH /
 * SUBSCRIBE_TRACKS にのみ出現でき、応答側の許可集合には含まれない。
 * 応答文脈への混入は PROTOCOL_VIOLATION で拒否されることを検証する。
 */
test("INCLUDE_PROPERTIES の応答への混入は PROTOCOL_VIOLATION で拒否される", () => {
  for (const allowed of [
    NAMESPACE_OK_ALLOWED_PARAMS,
    PUBLISH_OK_ALLOWED_PARAMS,
    REQUEST_UPDATE_OK_ALLOWED_PARAMS,
    TRACK_STATUS_OK_ALLOWED_PARAMS,
    SUBSCRIBE_OK_ALLOWED_PARAMS,
    FETCH_OK_ALLOWED_PARAMS,
    PUBLISH_STATE_NOTIFY_ALLOWED_PARAMS,
  ]) {
    const errors: SessionError[] = [];
    const result = validateParameterScope(
      [{ type: MessageParameterType.INCLUDE_PROPERTIES }],
      allowed,
      "RESPONSE",
      (error) => {
        errors.push(error);
      },
    );
    assert.isFalse(result);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].code, SessionErrorCode.PROTOCOL_VIOLATION);
  }
});
