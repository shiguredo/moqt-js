/**
 * GREASE 値 Property-Based Tests
 * draft-ietf-moq-transport-18 Section 14 (Grease)
 *
 * GREASE 値のパターン 0x7f * N + 0x9D が任意の非負整数 N で成り立つ
 * 不変条件を検証する。
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

// プロパティ 2: 生成値は定義式 0x7f * n + 0x9d と一致する
test("generateGreaseValue は 0x7f * n + 0x9d と一致する", () => {
  fc.assert(
    fc.property(fc.nat(), (n) => {
      assert.equal(generateGreaseValue(n), 0x7fn * BigInt(n) + 0x9dn);
    }),
  );
});

// プロパティ 3: 生成値はパターンの剰余不変条件を満たす
test("generateGreaseValue の値は (value - 0x9d) % 0x7f === 0 を満たす", () => {
  fc.assert(
    fc.property(fc.nat(), (n) => {
      const value = generateGreaseValue(n);
      assert.equal((value - 0x9dn) % 0x7fn, 0n);
      // 派生: value % 0x7f は 0x9d % 0x7f = 0x1e に等しい
      assert.equal(value % 0x7fn, 0x1en);
    }),
  );
});

// プロパティ 4: 生成値は n に対して単調増加する
test("generateGreaseValue は n に対して単調増加する", () => {
  fc.assert(
    fc.property(fc.nat(), (n) => {
      assert.isTrue(generateGreaseValue(n) < generateGreaseValue(n + 1));
    }),
  );
});

// プロパティ 5: GREASE 値に 1..0x7e を足した値は GREASE パターンから外れるため false
test("GREASE 値に 1..0x7e を足した値は isGreaseValue が false になる", () => {
  fc.assert(
    fc.property(fc.nat(), fc.integer({ min: 1, max: 0x7e }), (n, k) => {
      assert.isFalse(isGreaseValue(generateGreaseValue(n) + BigInt(k)));
    }),
  );
});

// プロパティ 6: 基数 0x9d 未満の値は GREASE 値ではない
test("0x9d 未満の値は isGreaseValue が false になる", () => {
  fc.assert(
    fc.property(fc.bigInt({ min: 0n, max: 0x9cn }), (v) => {
      assert.isFalse(isGreaseValue(v));
    }),
  );
});

// プロパティ 7: 負数のインデックスは拒否される
test("generateGreaseValue は負数のインデックスを拒否する", () => {
  fc.assert(
    fc.property(fc.integer({ max: -1 }), (n) => {
      assert.throws(() => generateGreaseValue(n), /GREASE index must be non-negative/);
    }),
  );
});
