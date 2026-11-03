/**
 * MOQT Setup Messages Unit Tests
 * draft-ietf-moq-transport-22 §9.1 (SETUP)
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
  getSetupMaxAuthTokenCacheSize,
  getSetupMaxControlMessageSize,
  getSetupMaxRequestUpdates,
  getSetupMaxFilterRanges,
  getSetupParameter,
} from "./setup";
import { encodeKeyValuePairs } from "./parameter";
import { AuthorizationTokenAliasType } from "./authorizationToken";
import { MessageType, SetupOptionType } from "./types";
import { MOQT_IMPLEMENTATION_VALUE } from "../version";
import { isGreaseValue } from "../grease";
import { decodeVarint, encodeVarint } from "../varint";
import { assertKeyValueFormattingError } from "../testSupport/helpers";

/**
 * draft-ietf-moq-transport-22 §9.1 (SETUP) / §6.3.2 (Extension Negotiation):
 * 未知の Setup Option は MUST ignore であり、解釈せずパラメータ配列に保持する。
 * 汎用の宣言形式が無いため、未知の Option を拡張の宣言として解釈しない。
 */
test("Setup: 未知の Setup Option は ignore して保持する", () => {
  // 0x0F は moqt-js が解釈しない未割当の Setup Option (GREASE は 0x7f * N + 0x9D)
  const payload = encodeKeyValuePairs([{ type: 0x0f, value: new Uint8Array([0x01]) }]);
  const decoded = decodeSetupPayload(payload);

  // 例外にならず、値も改変されない
  assert.equal(decoded.parameters.length, 1);
  assert.equal(decoded.parameters[0].type, 0x0f);
  assert.deepEqual(decoded.parameters[0].value, new Uint8Array([0x01]));
  // 未知の Option は既知の取得関数には現れない
  assert.isUndefined(getSetupPath(decoded));
  assert.isUndefined(getSetupAuthority(decoded));
  assert.isUndefined(getSetupMoqtImplementation(decoded));
  // 保持されているので型指定で取り出せる
  assert.equal(getSetupParameter(decoded, 0x0f)?.type, 0x0f);
});

/**
 * draft-ietf-moq-transport-22 §9.1 (SETUP):
 * "Receivers MUST allow duplicates of unknown Setup Options" であるため、
 * 未知の Option が重複していてもデコードは成功し、両方が保持される。
 */
test("Setup: 未知の Setup Option の重複を許容する", () => {
  const payload = encodeKeyValuePairs([
    { type: 0x0f, value: new Uint8Array([0x01]) },
    { type: 0x0f, value: new Uint8Array([0x02]) },
  ]);
  const decoded = decodeSetupPayload(payload);

  assert.equal(decoded.parameters.length, 2);
  assert.deepEqual(decoded.parameters[0].value, new Uint8Array([0x01]));
  assert.deepEqual(decoded.parameters[1].value, new Uint8Array([0x02]));
});

// MOQT_IMPLEMENTATION は既定で追加される（moqtImplementation で opt-out / override 可能）
test("Setup: パラメータなしで作成", () => {
  const setup = createSetup();
  assert.equal(setup.type, MessageType.SETUP);
  // MOQT_IMPLEMENTATION のみ
  assert.equal(setup.parameters.length, 1);
  assert.equal(setup.parameters[0].type, SetupOptionType.MOQT_IMPLEMENTATION);
  assert.equal(getSetupMoqtImplementation(setup), MOQT_IMPLEMENTATION_VALUE);
});

// draft-ietf-moq-transport-22 §9.1.1 / §9.1.2:
// AUTHORITY (0x05) / PATH (0x01) は WebTransport 使用時には MUST NOT 送信。
// moqt-js は WebTransport 専用クライアントのため createSetup には PATH / AUTHORITY を
// 受け付ける引数を持たない (送信不可) ことを確認する。
// 未指定の場合に PATH / AUTHORITY が存在しないこと (parameters 上にも現れないこと) と、
// 存在しないパラメータのゲッターが undefined を返すことを併せて固定する。
test("Setup: createSetup は PATH / AUTHORITY を含まず、未指定のパラメータは undefined", () => {
  const setup = createSetup();
  assert.isUndefined(setup.parameters.find((p) => p.type === SetupOptionType.PATH));
  assert.isUndefined(setup.parameters.find((p) => p.type === SetupOptionType.AUTHORITY));
  assert.isUndefined(getSetupPath(setup));
  assert.isUndefined(getSetupAuthority(setup));
  // MOQT_IMPLEMENTATION は既定で付与されるため存在する
  assert.isDefined(getSetupMoqtImplementation(setup));
});

// draft-ietf-moq-transport-22 §15.8 (Implementation Identification Fingerprinting):
// プライバシー緩和策として「オプションを完全に省略する」「汎用的な値を送る」
// 「利用者が設定・無効化できるようにする」が MAY として提示されている。
// moqtImplementation: false で opt-out（省略）、文字列で override（任意の値）を送信する。
// 既定 / opt-out / override（空文字列を含む）のラウンドトリップは setup.prop.ts の
// PBT が任意入力で検証するため、ここでは重複して検証しない。
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

// draft-ietf-moq-transport-22 §13 (Grease):
// GREASE 値は 0x7f * N + 0x9D パターンの予約値。grease: true で SETUP に 1 つ追加する。
// Option Type はランダム生成のため、isGreaseValue() で予約値であることを検証する。
// 未指定と grease: false は実装では同一分岐 (GREASE を追加しない) のため 1 件に統合する。
test("Setup: grease 未指定 / false は GREASE Option を含まない", () => {
  for (const options of [undefined, { grease: false }]) {
    const setup = createSetup(options);
    assert.isUndefined(setup.parameters.find((p) => isGreaseValue(BigInt(p.type))));
  }
});

test("Setup: grease: true は GREASE Setup Option を 1 つ含む", () => {
  // Option Type はランダム生成のため、複数回サンプリングして不変条件を検証する
  for (let i = 0; i < 100; i++) {
    const setup = createSetup({ grease: true });
    const greaseParams = setup.parameters.filter((p) => isGreaseValue(BigInt(p.type)));
    assert.equal(greaseParams.length, 1);
    // 奇数 Type（Length プレフィックス付きバイト列）であること
    assert.equal(greaseParams[0].type % 2, 1);
    // Parameter.type (number) で安全に表現できる範囲であること
    assert.equal(greaseParams[0].type <= Number.MAX_SAFE_INTEGER, true);
  }
});

test("Setup: grease: true の GREASE Option は roundtrip する", () => {
  // GREASE Type はランダムなため、複数回サンプリングして varint 長が異なる
  // ケース（小さい Type の 1 バイト〜大きい Type の 8 バイト）のエンコード経路を検証する
  for (let i = 0; i < 20; i++) {
    const setup = createSetup({ grease: true });
    const greaseParam = setup.parameters.find((p) => isGreaseValue(BigInt(p.type)));
    assert.isDefined(greaseParam);

    const encoded = encodeSetupPayload(setup);
    const decoded = decodeSetupPayload(encoded);

    const decodedGrease = decoded.parameters.find((p) => isGreaseValue(BigInt(p.type)));
    assert.isDefined(decodedGrease);
    assert.equal(decodedGrease?.type, greaseParam?.type);
  }
});

test("Setup: grease: true でも MOQT_IMPLEMENTATION は送信される", () => {
  // GREASE は他の Option に影響しない
  const setup = createSetup({ grease: true });
  assert.equal(getSetupMoqtImplementation(setup), MOQT_IMPLEMENTATION_VALUE);
});

// draft-ietf-moq-transport-22 §9.1:
// Setup Options は Key-Value-Pairs (Figure 3) としてシリアライズされ、
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

// draft-ietf-moq-transport-22 §9.1.4 (AUTHORIZATION TOKEN Setup Option)
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

// draft-ietf-moq-transport-22 §9.1.4 (AUTHORIZATION TOKEN):
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

// ============================================================================
// draft-22 適合監査: SETUP の上限広告 (A-5)
// ============================================================================

/**
 * draft-ietf-moq-transport-22 §9.1.3 / §9.1.7 / §9.1.6:
 * MAX_AUTH_TOKEN_CACHE_SIZE / MAX_REQUEST_UPDATES / MAX_FILTER_RANGES を
 * SETUP で広告でき、ラウンドトリップ後に各ゲッターで取得できることを検証する。
 */
test("Setup: MAX_AUTH_TOKEN_CACHE_SIZE / MAX_REQUEST_UPDATES / MAX_FILTER_RANGES を広告して roundtrip する", () => {
  const setup = createSetup({
    maxAuthTokenCacheSize: 1024,
    maxRequestUpdates: 8,
    maxFilterRanges: 4,
  });

  // 3 つの Option と MOQT_IMPLEMENTATION が含まれる
  assert.isDefined(
    setup.parameters.find((p) => p.type === SetupOptionType.MAX_AUTH_TOKEN_CACHE_SIZE),
  );
  assert.isDefined(setup.parameters.find((p) => p.type === SetupOptionType.MAX_REQUEST_UPDATES));
  assert.isDefined(setup.parameters.find((p) => p.type === SetupOptionType.MAX_FILTER_RANGES));

  const decoded = decodeSetupPayload(encodeSetupPayload(setup));
  assert.equal(getSetupMaxAuthTokenCacheSize(decoded), 1024);
  assert.equal(getSetupMaxRequestUpdates(decoded), 8);
  assert.equal(getSetupMaxFilterRanges(decoded), 4);
});

/**
 * draft-ietf-moq-transport-22 §9.1.3 / §9.1.7 / §9.1.6:
 * 各 Option を省略した場合の既定値は 0 であることを検証する
 * (MAX_REQUEST_UPDATES の 0 は無制限、MAX_FILTER_RANGES の 0 は受信拒否)。
 */
test("Setup: 上限 Option を省略すると既定値 0 になる", () => {
  const setup = createSetup();
  assert.equal(getSetupMaxAuthTokenCacheSize(setup), 0);
  assert.equal(getSetupMaxRequestUpdates(setup), 0);
  assert.equal(getSetupMaxFilterRanges(setup), 0);
});

/**
 * draft-ietf-moq-transport-22 §9.1.6 / §9.1.7:
 * 明示的に 0 を指定した場合も Option 自体は送信されることを検証する
 * (未指定と 0 はゲッター上では同じ 0 だが、ワイヤ上は区別される)。
 */
test("Setup: 上限に 0 を明示すると Option を送信する", () => {
  const setup = createSetup({ maxRequestUpdates: 0, maxFilterRanges: 0 });
  assert.isDefined(setup.parameters.find((p) => p.type === SetupOptionType.MAX_REQUEST_UPDATES));
  assert.isDefined(setup.parameters.find((p) => p.type === SetupOptionType.MAX_FILTER_RANGES));
});

// ============================================================================
// draft-ietf-moq-transport-23 §9.1.8: MAX_CONTROL_MESSAGE_SIZE (Option 0x09)
// ============================================================================

/**
 * draft-ietf-moq-transport-23 §9.1.8:
 * MAX_CONTROL_MESSAGE_SIZE は vi64 の値を持つ Setup Option であり、
 * Option Type 0x09 は奇数型のため Key-Value-Pair 規則で Length と値が続く。
 * 131072 (2^17) の vi64 は [0xc2, 0x00, 0x00] であり、KVP は
 * [0x09, 0x03, 0xc2, 0x00, 0x00] になる。
 */
test("Setup: MAX_CONTROL_MESSAGE_SIZE を広告すると vi64 の固定ワイヤで表現される", () => {
  const setup = createSetup({ maxControlMessageSize: 131072, moqtImplementation: false });
  const encoded = encodeSetupPayload(setup);

  assert.deepEqual(encoded, new Uint8Array([0x09, 0x03, 0xc2, 0x00, 0x00]));
  assert.equal(getSetupMaxControlMessageSize(setup), 131072);
});

/**
 * draft-ietf-moq-transport-23 §9.1.8:
 * 65535 は広告してよい最小値かつ既定値である。明示指定した場合は
 * SETUP Option を送信し、vi64 は 3 バイトの [0xc0, 0xff, 0xff] になる。
 */
test("Setup: MAX_CONTROL_MESSAGE_SIZE の最小値 65535 を明示すると送信する", () => {
  const setup = createSetup({ maxControlMessageSize: 65535, moqtImplementation: false });
  const encoded = encodeSetupPayload(setup);

  assert.deepEqual(encoded, new Uint8Array([0x09, 0x03, 0xc0, 0xff, 0xff]));
  assert.equal(getSetupMaxControlMessageSize(setup), 65535);
});

/**
 * draft-ietf-moq-transport-23 §9.1.8:
 * MAX_CONTROL_MESSAGE_SIZE を省略した場合、SETUP Option を送信せず、
 * 既定値 65535 を使う。
 */
test("Setup: MAX_CONTROL_MESSAGE_SIZE を省略すると Option を送らず既定値 65535", () => {
  const setup = createSetup({ moqtImplementation: false });
  assert.isUndefined(
    setup.parameters.find((p) => p.type === SetupOptionType.MAX_CONTROL_MESSAGE_SIZE),
  );
  assert.equal(getSetupMaxControlMessageSize(setup), 65535);
});

/**
 * draft-ietf-moq-transport-23 §9.1.8:
 * 65535 未満は広告できない。ローカル設定の誤りとして送信前に拒否する。
 */
test("Setup: MAX_CONTROL_MESSAGE_SIZE が 65535 未満なら作成時に throw", () => {
  assert.throws(() => createSetup({ maxControlMessageSize: 65534 }), "at least 65535");
});

/**
 * draft-ietf-moq-transport-23 §9.1.8:
 * 上限は 0 以上の安全な整数でなければならない。Number.MAX_SAFE_INTEGER を超える値と
 * 小数は、本文長の比較に使えないため作成時に拒否する。
 */
test("Setup: MAX_CONTROL_MESSAGE_SIZE が安全な整数でなければ作成時に throw", () => {
  assert.throws(
    () => createSetup({ maxControlMessageSize: Number.MAX_SAFE_INTEGER + 1 }),
    "at least 65535",
  );
  assert.throws(() => createSetup({ maxControlMessageSize: 1.5 }), "at least 65535");
  assert.throws(() => createSetup({ maxControlMessageSize: Number.NaN }), "at least 65535");
});

/**
 * draft-ietf-moq-transport-23 §9.1.8:
 * ピアが 65535 未満を広告することは仕様違反であり、Setup Option の Value が
 * Type の定義に一致しないため MALFORMED_KEY_VALUE (0x6) として扱う。
 */
test("Setup: ピアの MAX_CONTROL_MESSAGE_SIZE が 65535 未満なら MALFORMED_KEY_VALUE として扱う", () => {
  const decoded = decodeSetupPayload(
    encodeKeyValuePairs([
      { type: SetupOptionType.MAX_CONTROL_MESSAGE_SIZE, value: encodeVarint(65534) },
    ]),
  );

  assertKeyValueFormattingError(
    () => getSetupMaxControlMessageSize(decoded),
    /below the minimum 65535/,
  );
});

/**
 * draft-ietf-moq-transport-23 §8.3:
 * 既知の Type の Value が Type の定義する serialization と一致しない場合
 * (ここでは vi64 の後に余分なバイトがある場合) は MALFORMED_KEY_VALUE (0x6)
 * として扱う。
 */
test("Setup: MAX_CONTROL_MESSAGE_SIZE の Length が vi64 と一致しなければ MALFORMED_KEY_VALUE", () => {
  // vi64 の値 [0xc1, 0x00, 0x00] の後ろに余分な 0x00 を足し、Length 4 の値にする
  const decoded = decodeSetupPayload(
    encodeKeyValuePairs([
      {
        type: SetupOptionType.MAX_CONTROL_MESSAGE_SIZE,
        value: new Uint8Array([0xc1, 0x00, 0x00, 0x00]),
      },
    ]),
  );

  assertKeyValueFormattingError(
    () => getSetupMaxControlMessageSize(decoded),
    /does not match vi64 length/,
  );
});

/**
 * draft-ietf-moq-transport-23 §9.1.8:
 * vi64 の上限までの値を受け付ける。JS の数値の安全な範囲 (Number.MAX_SAFE_INTEGER) を
 * 超える広告値は、その上限に丸める (配列長はそれを超えないため実質的に無制限)。
 */
test("Setup: MAX_CONTROL_MESSAGE_SIZE の巨大な広告値は Number.MAX_SAFE_INTEGER に丸める", () => {
  // 2^60 は vi64 9 バイト [0xff, 0x10, 0x00 x 7]
  const decoded = decodeSetupPayload(
    encodeKeyValuePairs([
      {
        type: SetupOptionType.MAX_CONTROL_MESSAGE_SIZE,
        value: new Uint8Array([0xff, 0x10, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
      },
    ]),
  );

  assert.equal(getSetupMaxControlMessageSize(decoded), Number.MAX_SAFE_INTEGER);
});

/**
 * draft-ietf-moq-transport-23 §8.3:
 * MAX_CONTROL_MESSAGE_SIZE (奇数 Type) の Length 0 は vi64 として解釈できない
 * Value であり、serialization 不一致である。IncompleteDataError をそのまま
 * 伝播させず、MALFORMED_KEY_VALUE (0x6) の SessionError として返す。
 */
test("Setup: MAX_CONTROL_MESSAGE_SIZE の Length 0 は MALFORMED_KEY_VALUE として扱う", () => {
  const decoded = decodeSetupPayload(
    encodeKeyValuePairs([
      { type: SetupOptionType.MAX_CONTROL_MESSAGE_SIZE, value: new Uint8Array(0) },
    ]),
  );

  assertKeyValueFormattingError(
    () => getSetupMaxControlMessageSize(decoded),
    /not a complete vi64/,
  );
});
