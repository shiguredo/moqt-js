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
import { decodeVarint } from "../varint";

// MOQT_IMPLEMENTATION は既定で追加される（moqtImplementation で opt-out / override 可能）
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

// draft-ietf-moq-transport-19 §13.8 (Implementation Identification Fingerprinting):
// プライバシー緩和策として「オプションを完全に省略する」「汎用的な値を送る」
// 「利用者が設定・無効化できるようにする」が MAY として提示されている。
// moqtImplementation: false で opt-out（省略）、文字列で override（任意の値）を送信する。
// 既定 / opt-out / override のラウンドトリップは setup.prop.ts の PBT で検証する。
test("Setup: moqtImplementation: false は MOQT_IMPLEMENTATION を送信しない", () => {
  const setup = createSetup({ moqtImplementation: false });
  // MOQT_IMPLEMENTATION を抑止するため parameters は空になる
  assert.equal(setup.parameters.length, 0);
  assert.isUndefined(setup.parameters.find((p) => p.type === SetupOptionType.MOQT_IMPLEMENTATION));
  assert.isUndefined(getSetupMoqtImplementation(setup));
});

test("Setup: moqtImplementation の文字列 override を送信する", () => {
  const setup = createSetup({ moqtImplementation: "moqt-js" });
  assert.equal(setup.parameters.length, 1);
  assert.equal(getSetupMoqtImplementation(setup), "moqt-js");
});

test("Setup: moqtImplementation の空文字列 override を送信する", () => {
  // 空文字列も指定どおり送信する（値の妥当性検証は行わない）
  const setup = createSetup({ moqtImplementation: "" });
  assert.equal(setup.parameters.length, 1);
  assert.equal(getSetupMoqtImplementation(setup), "");
});

test("Setup: moqtImplementation: false でも AUTHORIZATION_TOKEN は送信される", () => {
  // opt-out は MOQT_IMPLEMENTATION のみに影響し、他の Option には影響しない
  const setup = createSetup({
    moqtImplementation: false,
    authorizationToken: {
      aliasType: AuthorizationTokenAliasType.USE_VALUE,
      tokenType: 0n,
      tokenValue: new TextEncoder().encode("jwt-payload"),
    },
  });
  assert.equal(setup.parameters.length, 1);
  assert.isDefined(setup.parameters.find((p) => p.type === SetupOptionType.AUTHORIZATION_TOKEN));
  assert.isUndefined(setup.parameters.find((p) => p.type === SetupOptionType.MOQT_IMPLEMENTATION));
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
