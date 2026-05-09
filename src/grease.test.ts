/**
 * GREASE 値テスト
 * draft-ietf-moq-transport-17 Section 13 (Grease)
 */

import { test, assert } from "vite-plus/test";
import { generateGreaseValue, isGreaseValue } from "./grease";

test("generateGreaseValue は GREASE パターンの値を生成する", () => {
  assert.equal(generateGreaseValue(0), 0x9dn);
  assert.equal(generateGreaseValue(1), 0x11cn);
  assert.equal(generateGreaseValue(2), 0x19bn);
  assert.equal(generateGreaseValue(3), 0x21an);
});

test("isGreaseValue は GREASE パターンを判定する", () => {
  assert.isTrue(isGreaseValue(0x9dn));
  assert.isTrue(isGreaseValue(0x11cn));
  assert.isTrue(isGreaseValue(0x19bn));
  assert.isFalse(isGreaseValue(0x9cn));
  assert.isFalse(isGreaseValue(0x9en));
  assert.isFalse(isGreaseValue(0n));
});

test("generateGreaseValue は負数を拒否する", () => {
  assert.throws(() => generateGreaseValue(-1), /GREASE index must be non-negative: -1/);
});
