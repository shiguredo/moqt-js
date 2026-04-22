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
  getSetupMoqtImplementation,
  getSetupParameter,
} from "./setup";
import { MessageType, SetupOptionType } from "./types";
import { MOQT_IMPLEMENTATION_VALUE } from "../version";
import { decodeVarint } from "../varint";
import { AuthorizationTokenAliasType, decodeAuthorizationToken } from "./authorizationToken";

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
test("Setup: USE_VALUE の AUTHORIZATION_TOKEN を付けて作成", () => {
  const tokenValue = new TextEncoder().encode("opaque-token");
  const setup = createSetup({
    authorizationToken: { kind: "useValue", tokenType: 0n, tokenValue },
  });
  const param = getSetupParameter(setup, SetupOptionType.AUTHORIZATION_TOKEN);
  assert.isDefined(param);
  if (!param) return;
  const token = decodeAuthorizationToken(param.value);
  assert.equal(token.kind, "useValue");
  if (token.kind === "useValue") {
    assert.equal(token.tokenType, 0n);
    assert.deepEqual(Array.from(token.tokenValue), Array.from(tokenValue));
  }
});

// draft-ietf-moq-transport-17 Section 9.4.1.4 (AUTHORIZATION TOKEN Setup Option)
test("Setup: REGISTER の AUTHORIZATION_TOKEN を付けて作成", () => {
  const tokenValue = new TextEncoder().encode("reg-token");
  const setup = createSetup({
    authorizationToken: { kind: "register", alias: 1n, tokenType: 2n, tokenValue },
  });
  const param = getSetupParameter(setup, SetupOptionType.AUTHORIZATION_TOKEN);
  assert.isDefined(param);
  if (!param) return;
  const token = decodeAuthorizationToken(param.value);
  assert.equal(token.kind, "register");
  if (token.kind === "register") {
    assert.equal(token.alias, 1n);
    assert.equal(token.tokenType, 2n);
    assert.deepEqual(Array.from(token.tokenValue), Array.from(tokenValue));
  }
});

test("Setup: AUTHORIZATION_TOKEN の encode/decode roundtrip", () => {
  const tokenValue = new TextEncoder().encode("abc");
  const setup = createSetup({
    authorizationToken: { kind: "useValue", tokenType: 5n, tokenValue },
  });
  const encoded = encodeSetupPayload(setup);
  const decoded = decodeSetupPayload(encoded);
  const param = getSetupParameter(decoded, SetupOptionType.AUTHORIZATION_TOKEN);
  assert.isDefined(param);
  if (!param) return;
  const token = decodeAuthorizationToken(param.value);
  assert.equal(token.kind, "useValue");
  if (token.kind === "useValue") {
    assert.equal(token.tokenType, 5n);
    assert.deepEqual(Array.from(token.tokenValue), Array.from(tokenValue));
  }
  // Alias Type バイトは Token Value の冒頭に正しく入る
  assert.equal(Number(decodeVarint(param.value, 0)[0]), AuthorizationTokenAliasType.USE_VALUE);
});
