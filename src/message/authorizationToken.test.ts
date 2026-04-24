/**
 * MOQT Authorization Token Unit Tests
 * draft-ietf-moq-transport-17 Section 9.3.2 (AUTHORIZATION TOKEN Parameter)
 */

import { test, assert } from "vite-plus/test";
import {
  AuthorizationTokenAliasType,
  type AuthorizationToken,
  assertAuthorizationTokenForSetup,
  decodeAuthorizationToken,
  encodeAuthorizationToken,
} from "./authorizationToken";
import { SessionError, SessionErrorCode } from "../error";

test("AuthorizationToken: USE_VALUE の roundtrip", () => {
  const tokenValue = new TextEncoder().encode("jwt-token-value");
  const original: AuthorizationToken = {
    aliasType: AuthorizationTokenAliasType.USE_VALUE,
    tokenType: 0n,
    tokenValue,
  };

  const encoded = encodeAuthorizationToken(original);
  const decoded = decodeAuthorizationToken(encoded);

  assert.equal(decoded.aliasType, AuthorizationTokenAliasType.USE_VALUE);
  if (decoded.aliasType === AuthorizationTokenAliasType.USE_VALUE) {
    assert.equal(decoded.tokenType, 0n);
    assert.deepEqual(Array.from(decoded.tokenValue), Array.from(tokenValue));
  }
});

test("AuthorizationToken: REGISTER の roundtrip", () => {
  const tokenValue = new TextEncoder().encode("session-token");
  const original: AuthorizationToken = {
    aliasType: AuthorizationTokenAliasType.REGISTER,
    tokenAlias: 42n,
    tokenType: 1n,
    tokenValue,
  };

  const encoded = encodeAuthorizationToken(original);
  const decoded = decodeAuthorizationToken(encoded);

  assert.equal(decoded.aliasType, AuthorizationTokenAliasType.REGISTER);
  if (decoded.aliasType === AuthorizationTokenAliasType.REGISTER) {
    assert.equal(decoded.tokenAlias, 42n);
    assert.equal(decoded.tokenType, 1n);
    assert.deepEqual(Array.from(decoded.tokenValue), Array.from(tokenValue));
  }
});

test("AuthorizationToken: USE_ALIAS の roundtrip", () => {
  const original: AuthorizationToken = {
    aliasType: AuthorizationTokenAliasType.USE_ALIAS,
    tokenAlias: 7n,
  };

  const encoded = encodeAuthorizationToken(original);
  const decoded = decodeAuthorizationToken(encoded);

  assert.equal(decoded.aliasType, AuthorizationTokenAliasType.USE_ALIAS);
  if (decoded.aliasType === AuthorizationTokenAliasType.USE_ALIAS) {
    assert.equal(decoded.tokenAlias, 7n);
  }
});

test("AuthorizationToken: DELETE の roundtrip", () => {
  const original: AuthorizationToken = {
    aliasType: AuthorizationTokenAliasType.DELETE,
    tokenAlias: 3n,
  };

  const encoded = encodeAuthorizationToken(original);
  const decoded = decodeAuthorizationToken(encoded);

  assert.equal(decoded.aliasType, AuthorizationTokenAliasType.DELETE);
  if (decoded.aliasType === AuthorizationTokenAliasType.DELETE) {
    assert.equal(decoded.tokenAlias, 3n);
  }
});

test("AuthorizationToken: USE_VALUE で空の Token Value を扱える", () => {
  const original: AuthorizationToken = {
    aliasType: AuthorizationTokenAliasType.USE_VALUE,
    tokenType: 0n,
    tokenValue: new Uint8Array(),
  };

  const encoded = encodeAuthorizationToken(original);
  const decoded = decodeAuthorizationToken(encoded);

  assert.equal(decoded.aliasType, AuthorizationTokenAliasType.USE_VALUE);
  if (decoded.aliasType === AuthorizationTokenAliasType.USE_VALUE) {
    assert.equal(decoded.tokenType, 0n);
    assert.equal(decoded.tokenValue.length, 0);
  }
});

// draft-ietf-moq-transport-17 Section 9.3.2:
// "If the Token structure cannot be decoded, the receiver MUST close
//  the Session with KEY_VALUE_FORMATTING_ERROR."
test("AuthorizationToken: デコード失敗で KEY_VALUE_FORMATTING_ERROR", () => {
  const invalid = new Uint8Array([0xff, 0x00]);
  try {
    decodeAuthorizationToken(invalid);
    assert.fail("expected decodeAuthorizationToken to throw");
  } catch (error) {
    assert.instanceOf(error, SessionError);
    assert.equal((error as SessionError).code, SessionErrorCode.KEY_VALUE_FORMATTING_ERROR);
  }
});

test("AuthorizationToken: 空データでデコード失敗", () => {
  const empty = new Uint8Array();
  try {
    decodeAuthorizationToken(empty);
    assert.fail("expected decodeAuthorizationToken to throw");
  } catch (error) {
    assert.instanceOf(error, SessionError);
    assert.equal((error as SessionError).code, SessionErrorCode.KEY_VALUE_FORMATTING_ERROR);
  }
});

// draft-ietf-moq-transport-17 Section 9.3.2:
// "If a server receives Alias Type DELETE (0x0) or USE_ALIAS (0x2) in a SETUP message,
//  it MUST close the session with a PROTOCOL_VIOLATION."
test("AuthorizationToken: SETUP では DELETE を拒否する", () => {
  const token: AuthorizationToken = {
    aliasType: AuthorizationTokenAliasType.DELETE,
    tokenAlias: 1n,
  };
  assert.throws(() => assertAuthorizationTokenForSetup(token), "not allowed in SETUP");
});

test("AuthorizationToken: SETUP では USE_ALIAS を拒否する", () => {
  const token: AuthorizationToken = {
    aliasType: AuthorizationTokenAliasType.USE_ALIAS,
    tokenAlias: 1n,
  };
  assert.throws(() => assertAuthorizationTokenForSetup(token), "not allowed in SETUP");
});

test("AuthorizationToken: SETUP では REGISTER / USE_VALUE を許可する", () => {
  const registerToken: AuthorizationToken = {
    aliasType: AuthorizationTokenAliasType.REGISTER,
    tokenAlias: 1n,
    tokenType: 0n,
    tokenValue: new Uint8Array([0x01]),
  };
  const useValueToken: AuthorizationToken = {
    aliasType: AuthorizationTokenAliasType.USE_VALUE,
    tokenType: 0n,
    tokenValue: new Uint8Array([0x01]),
  };

  assertAuthorizationTokenForSetup(registerToken);
  assertAuthorizationTokenForSetup(useValueToken);
});
