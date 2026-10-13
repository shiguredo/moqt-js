/**
 * MOQT Authorization Token Unit Tests
 * draft-ietf-moq-transport-22 Section 9.20.2 (AUTHORIZATION TOKEN Parameter)
 */

import { test, assert } from "vite-plus/test";
import {
  AuthorizationTokenAliasType,
  type AuthorizationToken,
  assertAuthorizationTokenForSetup,
  decodeAuthorizationToken,
} from "./authorizationToken";
import { SessionError, SessionErrorCode } from "../error";

// 4 種の Alias Type の round-trip（USE_VALUE / REGISTER / USE_ALIAS / DELETE、
// 空の Token Value を含む）は authorizationToken.prop.ts の PBT が任意入力で検証する。
// ここでは PBT では表現できない異常系と SETUP 文脈の制約のみを固定する。

// draft-ietf-moq-transport-22 Section 9.20.2:
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

// draft-ietf-moq-transport-22 Section 9.20.2:
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
