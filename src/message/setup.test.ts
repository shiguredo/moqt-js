/**
 * MOQT Setup Messages Unit Tests
 * draft-ietf-moq-transport-17 Section 9.4
 */

import { test, assert } from "vite-plus/test";
import {
  createSetup,
  encodeSetupPayload,
  decodeSetupPayload,
  getSetupPath,
  getSetupAuthority,
  getSetupAuthorizationTokens,
  getSetupMoqtImplementation,
} from "./setup";
import { AuthorizationTokenAliasType } from "./authorizationToken";
import { MessageType, SetupOptionType } from "./types";
import { MOQT_IMPLEMENTATION_VALUE } from "../version";
import { decodeVarint } from "../varint";

// MOQT_IMPLEMENTATION は常に追加される
test("Setup: パラメータなしで作成", () => {
  const setup = createSetup();
  assert.equal(setup.type, MessageType.SETUP);
  // MOQT_IMPLEMENTATION のみ
  assert.equal(setup.parameters.length, 1);
  assert.equal(setup.parameters[0].type, SetupOptionType.MOQT_IMPLEMENTATION);
  assert.equal(getSetupMoqtImplementation(setup), MOQT_IMPLEMENTATION_VALUE);
});

test("Setup: path パラメータ付きで作成", () => {
  const setup = createSetup({ path: "/moqt" });
  assert.equal(setup.type, MessageType.SETUP);
  // PATH + MOQT_IMPLEMENTATION
  assert.equal(setup.parameters.length, 2);
  assert.equal(setup.parameters[0].type, SetupOptionType.PATH);
  assert.equal(getSetupPath(setup), "/moqt");
  assert.equal(getSetupMoqtImplementation(setup), MOQT_IMPLEMENTATION_VALUE);
});

test("Setup: authority パラメータ付きで作成", () => {
  const setup = createSetup({ authority: "example.com" });
  assert.equal(setup.type, MessageType.SETUP);
  // AUTHORITY + MOQT_IMPLEMENTATION
  assert.equal(setup.parameters.length, 2);
  assert.equal(setup.parameters[0].type, SetupOptionType.AUTHORITY);
  assert.equal(getSetupAuthority(setup), "example.com");
  assert.equal(getSetupMoqtImplementation(setup), MOQT_IMPLEMENTATION_VALUE);
});

test("Setup: すべてのパラメータ付きで作成", () => {
  const setup = createSetup({
    path: "/moqt",
    authority: "example.com",
  });
  // PATH + AUTHORITY + MOQT_IMPLEMENTATION
  assert.equal(setup.parameters.length, 3);
  assert.equal(getSetupPath(setup), "/moqt");
  assert.equal(getSetupAuthority(setup), "example.com");
  assert.equal(getSetupMoqtImplementation(setup), MOQT_IMPLEMENTATION_VALUE);
});

test("Setup: 存在しないパラメータは undefined", () => {
  const setup = createSetup();
  assert.isUndefined(getSetupPath(setup));
  assert.isUndefined(getSetupAuthority(setup));
  // MOQT_IMPLEMENTATION は存在する
  assert.isDefined(getSetupMoqtImplementation(setup));
});

// draft-ietf-moq-transport-17 Section 9.4:
// Setup Options は Key-Value-Pairs (Figure 2) としてシリアライズされ、
// カウントプレフィックスを持たない。Length フィールドで終端が決まる。
test("Setup: エンコード結果にカウントプレフィックスがない", () => {
  const setup = createSetup();
  const encoded = encodeSetupPayload(setup);

  // 先頭バイトをデコードしてカウント値ではないことを確認する。
  // カウントプレフィックスがある場合、先頭は varint(1) = 0x01 になる。
  // カウントプレフィックスがない場合、先頭は Delta Type (最初の Setup Option の Type) になる。
  // MOQT_IMPLEMENTATION の Type は 0x07 なので、Delta Type = 0x07。
  const [firstVarint] = decodeVarint(encoded, 0);
  assert.equal(Number(firstVarint), SetupOptionType.MOQT_IMPLEMENTATION);
});

test("Setup: エンコード・デコード roundtrip", () => {
  const setup = createSetup({ path: "/moqt", authority: "example.com" });
  const encoded = encodeSetupPayload(setup);
  const decoded = decodeSetupPayload(encoded);

  assert.equal(decoded.type, MessageType.SETUP);
  assert.equal(getSetupPath(decoded), "/moqt");
  assert.equal(getSetupAuthority(decoded), "example.com");
  assert.equal(getSetupMoqtImplementation(decoded), MOQT_IMPLEMENTATION_VALUE);
});

// draft-ietf-moq-transport-17 Section 9.4.1.4 (AUTHORIZATION TOKEN Setup Option)
test("Setup: AUTHORIZATION_TOKEN (USE_VALUE) 付きで roundtrip", () => {
  const tokenValue = new TextEncoder().encode("jwt-payload");
  const setup = createSetup({
    authorizationToken: {
      aliasType: AuthorizationTokenAliasType.USE_VALUE,
      tokenType: 0n,
      tokenValue,
    },
  });

  // parameters には AUTHORIZATION_TOKEN と MOQT_IMPLEMENTATION が含まれる
  assert.equal(setup.parameters.length, 2);
  assert.isDefined(setup.parameters.find((p) => p.type === SetupOptionType.AUTHORIZATION_TOKEN));

  const encoded = encodeSetupPayload(setup);
  const decoded = decodeSetupPayload(encoded);

  const tokens = getSetupAuthorizationTokens(decoded);
  assert.equal(tokens.length, 1);
  assert.equal(tokens[0].aliasType, AuthorizationTokenAliasType.USE_VALUE);
  if (tokens[0].aliasType === AuthorizationTokenAliasType.USE_VALUE) {
    assert.equal(tokens[0].tokenType, 0n);
    assert.deepEqual(Array.from(tokens[0].tokenValue), Array.from(tokenValue));
  }
});

test("Setup: AUTHORIZATION_TOKEN (REGISTER) 付きで roundtrip", () => {
  const tokenValue = new TextEncoder().encode("register-value");
  const setup = createSetup({
    authorizationToken: {
      aliasType: AuthorizationTokenAliasType.REGISTER,
      tokenAlias: 5n,
      tokenType: 1n,
      tokenValue,
    },
  });

  const encoded = encodeSetupPayload(setup);
  const decoded = decodeSetupPayload(encoded);

  const tokens = getSetupAuthorizationTokens(decoded);
  assert.equal(tokens.length, 1);
  assert.equal(tokens[0].aliasType, AuthorizationTokenAliasType.REGISTER);
  if (tokens[0].aliasType === AuthorizationTokenAliasType.REGISTER) {
    assert.equal(tokens[0].tokenAlias, 5n);
    assert.equal(tokens[0].tokenType, 1n);
    assert.deepEqual(Array.from(tokens[0].tokenValue), Array.from(tokenValue));
  }
});

// draft-ietf-moq-transport-17 Section 9.3.2:
// "If a server receives Alias Type DELETE (0x0) or USE_ALIAS (0x2) in a SETUP message,
//  it MUST close the session with a PROTOCOL_VIOLATION."
test("Setup: SETUP で DELETE の Authorization Token を指定すると throw", () => {
  assert.throws(
    () =>
      createSetup({
        authorizationToken: {
          aliasType: AuthorizationTokenAliasType.DELETE,
          tokenAlias: 1n,
        },
      }),
    "not allowed in SETUP",
  );
});

test("Setup: SETUP で USE_ALIAS の Authorization Token を指定すると throw", () => {
  assert.throws(
    () =>
      createSetup({
        authorizationToken: {
          aliasType: AuthorizationTokenAliasType.USE_ALIAS,
          tokenAlias: 1n,
        },
      }),
    "not allowed in SETUP",
  );
});

test("Setup: AUTHORIZATION_TOKEN の Setup Option Type は 0x03", () => {
  assert.equal(SetupOptionType.AUTHORIZATION_TOKEN, 0x03);
});
