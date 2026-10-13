/**
 * GREASE 値 Property-Based Tests
 * draft-ietf-moq-transport-22 Section 13 (Grease)
 *
 * 生成した GREASE 値が必ず判定 (isGreaseValue) を通ることと、パターンから外れた値が
 * 通らないことを任意のインデックスで検証する。定義式そのものとの一致は、代表値を pin
 * する回帰アンカー (先頭のテスト) が担う。
 */

import { test, assert } from "vite-plus/test";
import * as fc from "fast-check";
import { generateGreaseValue, isGreaseValue } from "./grease";

// 回帰アンカー: 仕様の代表的な GREASE 値 (0x9D, 0x11C, 0x19B, 0x21A) を明示的に pin する
test("generateGreaseValue: 代表値が仕様のパターンと一致する", () => {
  assert.equal(generateGreaseValue(0), 0x9dn);
  assert.equal(generateGreaseValue(1), 0x11cn);
  assert.equal(generateGreaseValue(2), 0x19bn);
  assert.equal(generateGreaseValue(3), 0x21an);
});

// プロパティ 1: 生成した GREASE 値は必ず isGreaseValue が true になる (生成 -> 判定の往復)
test("generateGreaseValue で生成した値は isGreaseValue が true になる", () => {
  fc.assert(
    fc.property(fc.nat(), (n) => {
      assert.isTrue(isGreaseValue(generateGreaseValue(n)));
    }),
  );
});

// プロパティ 2: GREASE 値に 1..0x7e を足した値は GREASE パターンから外れるため false
test("GREASE 値に 1..0x7e を足した値は isGreaseValue が false になる", () => {
  fc.assert(
    fc.property(fc.nat(), fc.integer({ min: 1, max: 0x7e }), (n, k) => {
      assert.isFalse(isGreaseValue(generateGreaseValue(n) + BigInt(k)));
    }),
  );
});

// プロパティ 3: 基数 0x9d 未満の値は GREASE 値ではない
test("0x9d 未満の値は isGreaseValue が false になる", () => {
  fc.assert(
    fc.property(fc.bigInt({ min: 0n, max: 0x9cn }), (v) => {
      assert.isFalse(isGreaseValue(v));
    }),
  );
});

// プロパティ 4: 負数のインデックスは拒否される
test("generateGreaseValue は負数のインデックスを拒否する", () => {
  fc.assert(
    fc.property(fc.integer({ max: -1 }), (n) => {
      assert.throws(() => generateGreaseValue(n), /GREASE index must be non-negative/);
    }),
  );
});

// プロパティ 5: 非負の非整数・非有限のインデックスは BigInt 変換の RangeError になる
// 非負検査 (n < 0) は通過するが、BigInt(n) が整数以外を拒否するため、
// 専用のエラー文言ではなく RangeError が呼び出し側へ漏れる。
test("generateGreaseValue は非負の非整数・非有限のインデックスを RangeError で拒否する", () => {
  for (const n of [1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => generateGreaseValue(n), RangeError);
  }
});

// プロパティ 6: 負の非整数は非負検査で拒否される (BigInt 変換まで到達しない)
test("generateGreaseValue は負の非整数も非負検査で拒否する", () => {
  assert.throws(() => generateGreaseValue(-0.5), /GREASE index must be non-negative/);
});
