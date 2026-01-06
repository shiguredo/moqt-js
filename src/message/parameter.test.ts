/**
 * MOQT Parameter Unit Tests
 * draft-ietf-moq-transport-15 Section 9
 */

import { test, assert } from "vitest";
import { decodeSubscriptionFilter, decodeSubscriptionFilterParameter } from "./parameter";

test("無効なパラメータタイプでエラー", () => {
  const invalidParam = { type: 0x20, value: new Uint8Array([0x01]) };
  assert.throws(() => decodeSubscriptionFilterParameter(invalidParam), "Invalid parameter type");
});

test("無効なフィルタタイプでエラー", () => {
  const invalidData = new Uint8Array([0x10]);
  assert.throws(() => decodeSubscriptionFilter(invalidData), "Unknown filter type");
});
