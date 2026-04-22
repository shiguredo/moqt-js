/**
 * MOQT AUTHORIZATION_TOKEN Token 構造 Unit Tests
 * draft-ietf-moq-transport-17 Section 9.3.2
 */

import { assert, test } from "vite-plus/test";
import { SessionError, SessionErrorCode } from "../error";
import { encodeVarint } from "../varint";
import {
  type AuthorizationToken,
  AuthorizationTokenAliasType,
  decodeAuthorizationToken,
  encodeAuthorizationToken,
} from "./authorizationToken";

function roundtrip(token: AuthorizationToken): AuthorizationToken {
  return decodeAuthorizationToken(encodeAuthorizationToken(token));
}

test("DELETE の round-trip で alias が保持される", () => {
  const decoded = roundtrip({ kind: "delete", alias: 42n });
  assert.equal(decoded.kind, "delete");
  if (decoded.kind === "delete") {
    assert.equal(decoded.alias, 42n);
  }
});

test("USE_ALIAS の round-trip で alias が保持される", () => {
  const decoded = roundtrip({ kind: "useAlias", alias: 7n });
  assert.equal(decoded.kind, "useAlias");
  if (decoded.kind === "useAlias") {
    assert.equal(decoded.alias, 7n);
  }
});

test("REGISTER の round-trip で alias / tokenType / tokenValue が保持される", () => {
  const value = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
  const decoded = roundtrip({ kind: "register", alias: 1n, tokenType: 3n, tokenValue: value });
  assert.equal(decoded.kind, "register");
  if (decoded.kind === "register") {
    assert.equal(decoded.alias, 1n);
    assert.equal(decoded.tokenType, 3n);
    assert.deepEqual(Array.from(decoded.tokenValue), [0xde, 0xad, 0xbe, 0xef]);
  }
});

test("USE_VALUE の round-trip で tokenType / tokenValue が保持される", () => {
  const value = new Uint8Array([0x01, 0x02, 0x03]);
  const decoded = roundtrip({ kind: "useValue", tokenType: 9n, tokenValue: value });
  assert.equal(decoded.kind, "useValue");
  if (decoded.kind === "useValue") {
    assert.equal(decoded.tokenType, 9n);
    assert.deepEqual(Array.from(decoded.tokenValue), [0x01, 0x02, 0x03]);
  }
});

test("REGISTER の tokenValue は空でもよい", () => {
  const decoded = roundtrip({
    kind: "register",
    alias: 2n,
    tokenType: 0n,
    tokenValue: new Uint8Array(),
  });
  assert.equal(decoded.kind, "register");
  if (decoded.kind === "register") {
    assert.equal(decoded.tokenValue.length, 0);
  }
});

test("USE_VALUE の tokenValue は空でもよい", () => {
  const decoded = roundtrip({
    kind: "useValue",
    tokenType: 1n,
    tokenValue: new Uint8Array(),
  });
  assert.equal(decoded.kind, "useValue");
  if (decoded.kind === "useValue") {
    assert.equal(decoded.tokenValue.length, 0);
  }
});

test("未知の Alias Type は KEY_VALUE_FORMATTING_ERROR で throw する", () => {
  const data = encodeVarint(0x42);
  try {
    decodeAuthorizationToken(data);
    assert.fail("should throw");
  } catch (e) {
    assert.ok(e instanceof SessionError);
    assert.equal((e as SessionError).code, SessionErrorCode.KEY_VALUE_FORMATTING_ERROR);
  }
});

test("DELETE / USE_ALIAS の末尾に余剰バイトがあると KEY_VALUE_FORMATTING_ERROR", () => {
  const deleteWithTail = new Uint8Array([
    ...encodeVarint(AuthorizationTokenAliasType.DELETE),
    ...encodeVarint(1n),
    0xff,
  ]);
  assert.throws(() => decodeAuthorizationToken(deleteWithTail));

  const useAliasWithTail = new Uint8Array([
    ...encodeVarint(AuthorizationTokenAliasType.USE_ALIAS),
    ...encodeVarint(1n),
    0xff,
  ]);
  assert.throws(() => decodeAuthorizationToken(useAliasWithTail));
});

test("alias の途中で切れていたら KEY_VALUE_FORMATTING_ERROR", () => {
  const truncated = new Uint8Array(encodeVarint(AuthorizationTokenAliasType.REGISTER));
  try {
    decodeAuthorizationToken(truncated);
    assert.fail("should throw");
  } catch (e) {
    assert.ok(e instanceof SessionError);
    assert.equal((e as SessionError).code, SessionErrorCode.KEY_VALUE_FORMATTING_ERROR);
  }
});

test("空の Value を渡すと alias type のデコードで失敗する", () => {
  assert.throws(() => decodeAuthorizationToken(new Uint8Array()));
});

test("encodeAuthorizationToken は先頭バイトに Alias Type を書き込む", () => {
  assert.equal(
    encodeAuthorizationToken({ kind: "delete", alias: 0n })[0],
    AuthorizationTokenAliasType.DELETE,
  );
  assert.equal(
    encodeAuthorizationToken({
      kind: "register",
      alias: 0n,
      tokenType: 0n,
      tokenValue: new Uint8Array(),
    })[0],
    AuthorizationTokenAliasType.REGISTER,
  );
  assert.equal(
    encodeAuthorizationToken({ kind: "useAlias", alias: 0n })[0],
    AuthorizationTokenAliasType.USE_ALIAS,
  );
  assert.equal(
    encodeAuthorizationToken({ kind: "useValue", tokenType: 0n, tokenValue: new Uint8Array() })[0],
    AuthorizationTokenAliasType.USE_VALUE,
  );
});
