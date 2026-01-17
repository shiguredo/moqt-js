/**
 * MOQT Setup Messages Unit Tests
 * draft-ietf-moq-transport-16 Section 9.1
 */

import { test, assert } from "vitest";
import {
  createClientSetup,
  createServerSetup,
  getSetupPath,
  getSetupMaxRequestId,
  getSetupAuthority,
  getSetupMoqtImplementation,
} from "./setup";
import { MessageType, SetupParameterType } from "./types";
import { MOQT_IMPLEMENTATION_VALUE } from "../version";

// MOQT_IMPLEMENTATION は常に追加される
test("ClientSetup: パラメータなしで作成", () => {
  const setup = createClientSetup();
  assert.equal(setup.type, MessageType.CLIENT_SETUP);
  // MOQT_IMPLEMENTATION のみ
  assert.equal(setup.parameters.length, 1);
  assert.equal(setup.parameters[0].type, SetupParameterType.MOQT_IMPLEMENTATION);
  assert.equal(getSetupMoqtImplementation(setup), MOQT_IMPLEMENTATION_VALUE);
});

test("ClientSetup: path パラメータ付きで作成", () => {
  const setup = createClientSetup({ path: "/moqt" });
  assert.equal(setup.type, MessageType.CLIENT_SETUP);
  // PATH + MOQT_IMPLEMENTATION
  assert.equal(setup.parameters.length, 2);
  assert.equal(setup.parameters[0].type, SetupParameterType.PATH);
  assert.equal(getSetupPath(setup), "/moqt");
  assert.equal(getSetupMoqtImplementation(setup), MOQT_IMPLEMENTATION_VALUE);
});

test("ClientSetup: maxRequestId パラメータ付きで作成", () => {
  const setup = createClientSetup({ maxRequestId: 1000n });
  assert.equal(setup.type, MessageType.CLIENT_SETUP);
  // MAX_REQUEST_ID + MOQT_IMPLEMENTATION
  assert.equal(setup.parameters.length, 2);
  assert.equal(setup.parameters[0].type, SetupParameterType.MAX_REQUEST_ID);
  assert.equal(getSetupMaxRequestId(setup), 1000n);
  assert.equal(getSetupMoqtImplementation(setup), MOQT_IMPLEMENTATION_VALUE);
});

test("ClientSetup: authority パラメータ付きで作成", () => {
  const setup = createClientSetup({ authority: "example.com" });
  assert.equal(setup.type, MessageType.CLIENT_SETUP);
  // AUTHORITY + MOQT_IMPLEMENTATION
  assert.equal(setup.parameters.length, 2);
  assert.equal(setup.parameters[0].type, SetupParameterType.AUTHORITY);
  assert.equal(getSetupAuthority(setup), "example.com");
  assert.equal(getSetupMoqtImplementation(setup), MOQT_IMPLEMENTATION_VALUE);
});

test("ClientSetup: すべてのパラメータ付きで作成", () => {
  const setup = createClientSetup({
    path: "/moqt",
    maxRequestId: 500n,
    authority: "example.com",
  });
  // PATH + MAX_REQUEST_ID + AUTHORITY + MOQT_IMPLEMENTATION
  assert.equal(setup.parameters.length, 4);
  assert.equal(getSetupPath(setup), "/moqt");
  assert.equal(getSetupMaxRequestId(setup), 500n);
  assert.equal(getSetupAuthority(setup), "example.com");
  assert.equal(getSetupMoqtImplementation(setup), MOQT_IMPLEMENTATION_VALUE);
});

test("ClientSetup: 存在しないパラメータは undefined", () => {
  const setup = createClientSetup();
  assert.isUndefined(getSetupPath(setup));
  assert.isUndefined(getSetupMaxRequestId(setup));
  assert.isUndefined(getSetupAuthority(setup));
  // MOQT_IMPLEMENTATION は存在する
  assert.isDefined(getSetupMoqtImplementation(setup));
});

test("ServerSetup: パラメータなしで作成", () => {
  const setup = createServerSetup();
  assert.equal(setup.type, MessageType.SERVER_SETUP);
  assert.equal(setup.parameters.length, 0);
});

test("ServerSetup: maxRequestId パラメータ付きで作成", () => {
  const setup = createServerSetup({ maxRequestId: 2000n });
  assert.equal(setup.type, MessageType.SERVER_SETUP);
  assert.equal(setup.parameters.length, 1);
  assert.equal(getSetupMaxRequestId(setup), 2000n);
});
