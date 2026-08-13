/**
 * Parameter Scope 検証の単体テスト
 * draft-ietf-moq-transport-19 §10.2.1 (Parameter Scope) / §10.2.15 (EXPIRES Parameter)
 */

import { test, assert } from "vite-plus/test";
import {
  NAMESPACE_OK_ALLOWED_PARAMS,
  PUBLISH_OK_ALLOWED_PARAMS,
  PUBLISH_ALLOWED_PARAMS,
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
 * draft-ietf-moq-transport-19 §10.2.8:
 * GROUP_ORDER は PUBLISH_OK から削除された。
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
