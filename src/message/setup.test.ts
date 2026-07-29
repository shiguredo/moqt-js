/**
 * MOQT Setup Messages Unit Tests
 * draft-ietf-moq-transport-19 Section 10.3
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
import { isGreaseValue } from "../grease";
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

// draft-ietf-moq-transport-19 §10.3.1.1 / §10.3.1.2:
// AUTHORITY (0x05) / PATH (0x01) は WebTransport 使用時には MUST NOT 送信。
// moqt-js は WebTransport 専用クライアントのため createSetup には PATH / AUTHORITY を
// 受け付ける引数を持たない (送信不可) ことを確認する。
test("Setup: createSetup は PATH / AUTHORITY を含まない", () => {
  const setup = createSetup();
  assert.isUndefined(getSetupPath(setup));
  assert.isUndefined(getSetupAuthority(setup));
  assert.isUndefined(setup.parameters.find((p) => p.type === SetupOptionType.PATH));
  assert.isUndefined(setup.parameters.find((p) => p.type === SetupOptionType.AUTHORITY));
});

test("Setup: 存在しないパラメータは undefined", () => {
  const setup = createSetup();
  assert.isUndefined(getSetupPath(setup));
  assert.isUndefined(getSetupAuthority(setup));
  // MOQT_IMPLEMENTATION は存在する
  assert.isDefined(getSetupMoqtImplementation(setup));
});

// draft-ietf-moq-transport-19 Section 10.3:
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

test("Setup: エンコード・デコード roundtrip (MOQT_IMPLEMENTATION のみ)", () => {
  const setup = createSetup();
  const encoded = encodeSetupPayload(setup);
  const decoded = decodeSetupPayload(encoded);

  assert.equal(decoded.type, MessageType.SETUP);
  assert.isUndefined(getSetupPath(decoded));
  assert.isUndefined(getSetupAuthority(decoded));
  assert.equal(getSetupMoqtImplementation(decoded), MOQT_IMPLEMENTATION_VALUE);
});

// draft-ietf-moq-transport-19 Section 10.3.1.4 (AUTHORIZATION TOKEN Setup Option)
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

// draft-ietf-moq-transport-19 Section 10.2.2:
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

// draft-ietf-moq-transport-19 §13.8 (Implementation Identification Fingerprinting):
// "Privacy-conscious deployments MAY omit the MOQT_IMPLEMENTATION option entirely
//  or send a generic value."
// "Implementations MAY provide users with the ability to configure or disable the
//  MOQT_IMPLEMENTATION option."

// moqtImplementation: false で MOQT_IMPLEMENTATION が送信されないことを確認する
test("Setup: moqtImplementation=false で MOQT_IMPLEMENTATION が含まれない", () => {
  const setup = createSetup({ moqtImplementation: false });
  assert.equal(setup.parameters.length, 0);
  assert.isUndefined(getSetupMoqtImplementation(setup));
});

// moqtImplementation: string でカスタム値が送信されることを確認する
test("Setup: moqtImplementation=string でカスタム値が送信される", () => {
  const setup = createSetup({ moqtImplementation: "generic" });
  assert.equal(setup.parameters.length, 1);
  assert.equal(setup.parameters[0].type, SetupOptionType.MOQT_IMPLEMENTATION);
  assert.equal(getSetupMoqtImplementation(setup), "generic");
});

// moqtImplementation 未指定時は既定値が送信されることを確認する（後方互換）
test("Setup: moqtImplementation 未指定時は既定値が送信される", () => {
  const setup = createSetup({});
  assert.equal(getSetupMoqtImplementation(setup), MOQT_IMPLEMENTATION_VALUE);
});

// opt-out 時のエンコード・デコード roundtrip
test("Setup: moqtImplementation=false で roundtrip 時にパラメータ空", () => {
  const setup = createSetup({ moqtImplementation: false });
  const encoded = encodeSetupPayload(setup);
  const decoded = decodeSetupPayload(encoded);
  assert.equal(decoded.parameters.length, 0);
  assert.isUndefined(getSetupMoqtImplementation(decoded));
});

// override 時のエンコード・デコード roundtrip
test("Setup: moqtImplementation=string で roundtrip 時にカスタム値が維持される", () => {
  const setup = createSetup({ moqtImplementation: "my-app/1.0" });
  const encoded = encodeSetupPayload(setup);
  const decoded = decodeSetupPayload(encoded);
  assert.equal(getSetupMoqtImplementation(decoded), "my-app/1.0");
});

// AUTHORIZATION_TOKEN と moqtImplementation=false の組み合わせ
test("Setup: AUTHORIZATION_TOKEN あり + moqtImplementation=false で TOKEN のみ含まれる", () => {
  const tokenValue = new TextEncoder().encode("test-token");
  const setup = createSetup({
    authorizationToken: {
      aliasType: AuthorizationTokenAliasType.USE_VALUE,
      tokenType: 0n,
      tokenValue,
    },
    moqtImplementation: false,
  });
  assert.equal(setup.parameters.length, 1);
  assert.isDefined(setup.parameters.find((p) => p.type === SetupOptionType.AUTHORIZATION_TOKEN));
  assert.isUndefined(setup.parameters.find((p) => p.type === SetupOptionType.MOQT_IMPLEMENTATION));
});

// draft-ietf-moq-transport-19 Section 14 (Grease):
// GREASE Setup Option は opt-in で送信する。
// 受信側は未知の Setup Option を MUST ignore する。

// grease 未指定時は GREASE Setup Option が含まれないことを確認する（既定挙動）
test("Setup: grease 未指定時は GREASE Setup Option が含まれない", () => {
  const setup = createSetup();
  // MOQT_IMPLEMENTATION のみ
  assert.equal(setup.parameters.length, 1);
  const greaseParams = setup.parameters.filter((p) => isGreaseValue(BigInt(p.type)));
  assert.equal(greaseParams.length, 0);
});

// grease=false 時も GREASE Setup Option が含まれないことを確認する
test("Setup: grease=false で GREASE Setup Option が含まれない", () => {
  const setup = createSetup({ grease: false });
  assert.equal(setup.parameters.length, 1);
  const greaseParams = setup.parameters.filter((p) => isGreaseValue(BigInt(p.type)));
  assert.equal(greaseParams.length, 0);
});

// grease=true で GREASE Setup Option が 1 つ追加されることを確認する
test("Setup: grease=true で GREASE Setup Option が 1 つ追加される", () => {
  const setup = createSetup({ grease: true });
  // MOQT_IMPLEMENTATION + GREASE の 2 つ
  assert.equal(setup.parameters.length, 2);
  const greaseParams = setup.parameters.filter((p) => isGreaseValue(BigInt(p.type)));
  assert.equal(greaseParams.length, 1);
  // GREASE Setup Option の value は任意のバイト列（空でない）
  assert.isTrue(greaseParams[0].value.length > 0);
});

// grease=true 時のエンコード・デコード roundtrip
test("Setup: grease=true で roundtrip 時に GREASE Option が維持される", () => {
  const setup = createSetup({ grease: true });
  const encoded = encodeSetupPayload(setup);
  const decoded = decodeSetupPayload(encoded);
  const greaseParams = decoded.parameters.filter((p) => isGreaseValue(BigInt(p.type)));
  assert.equal(greaseParams.length, 1);
  // MOQT_IMPLEMENTATION も維持される
  assert.equal(getSetupMoqtImplementation(decoded), MOQT_IMPLEMENTATION_VALUE);
});

// grease=true + moqtImplementation=false の組み合わせ
test("Setup: grease=true + moqtImplementation=false で GREASE のみ含まれる", () => {
  const setup = createSetup({ grease: true, moqtImplementation: false });
  assert.equal(setup.parameters.length, 1);
  const greaseParams = setup.parameters.filter((p) => isGreaseValue(BigInt(p.type)));
  assert.equal(greaseParams.length, 1);
  assert.isUndefined(getSetupMoqtImplementation(setup));
});
