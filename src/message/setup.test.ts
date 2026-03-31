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
} from "./setup";
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
