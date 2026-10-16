/**
 * summarizeTimings の Property-Based Tests
 *
 * 値の分布を p50 / p95 / max に要約する関数が満たすべき性質を、任意の値の列で確かめる。
 * この要約は映像と音声の時間の統計で共通に使うため、値の並びに依存しないこと (並べ替えても
 * 同じ結果になること) と、百分位の意味 (その値以下の要素が全体の p 割以上あること) を
 * 直接固定する。
 *
 * - 値が無ければ null、あれば必ず要約を返す
 * - `max` は入力の最大値であり、`p50 <= p95 <= max` が成り立つ
 * - `p50` / `p95` / `max` は入力に含まれる値そのものである
 * - 入力の並びを変えても結果は変わらない
 * - 入力の p 割以上が `p` の百分位以下である (nearest-rank 法の意味)
 *
 * 具体的な添字の決め方 (昇順に並べて `ceil(p * n)` 番目) は src/playout/timingSummary.test.ts の
 * 単体テストが固定する。
 */

import { test, assert } from "vite-plus/test";
import * as fc from "fast-check";
import { summarizeTimings } from "./timingSummary";

/** 決定的な擬似乱数で入力の並びを入れ替える (結果が並びに依存しないことの検証用) */
function shuffled(values: readonly number[], seed: number): number[] {
  const result = [...values];
  let state = seed;
  for (let index = result.length - 1; index > 0; index--) {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    const swap = state % (index + 1);
    const current = result[index] ?? 0;
    result[index] = result[swap] ?? 0;
    result[swap] = current;
  }
  return result;
}

/** 値の列を作る (空の列と 1 件も通す) */
function valuesArbitrary() {
  return fc.array(fc.double({ min: -1_000_000, max: 1_000_000, noNaN: true }), { maxLength: 40 });
}

test("summarizeTimings: 値が無ければ null、あれば p50 <= p95 <= max で、すべて入力の値である", () => {
  fc.assert(
    fc.property(valuesArbitrary(), (values) => {
      const summary = summarizeTimings(values);
      if (values.length === 0) {
        assert.isNull(summary, "値が無ければ null を返すこと");
        return;
      }
      assert.isNotNull(summary, "値があれば要約を返すこと");
      const maximum = Math.max(...values);
      assert.equal(summary.max, maximum, "max が入力の最大値であること");
      assert.isAtMost(summary.p50, summary.p95, "p50 <= p95 であること");
      assert.isAtMost(summary.p95, summary.max, "p95 <= max であること");
      // 百分位は入力から選ぶ (補間しない) ため、必ず入力に含まれる値になる
      for (const [name, value] of [
        ["p50", summary.p50],
        ["p95", summary.p95],
        ["max", summary.max],
      ] as const) {
        assert.isTrue(values.includes(value), `${name} (${value}) が入力に含まれる値であること`);
      }
    }),
    { numRuns: 300 },
  );
});

test("summarizeTimings: 入力の並びを変えても結果は変わらない", () => {
  fc.assert(
    fc.property(valuesArbitrary(), fc.integer({ min: 0, max: 1_000_000 }), (values, seed) => {
      const summary = summarizeTimings(values);
      assert.deepEqual(
        summarizeTimings(shuffled(values, seed)),
        summary,
        "並べ替えた入力でも同じ要約になること",
      );
    }),
    { numRuns: 200 },
  );
});

/**
 * 百分位の意味を直接確かめる
 *
 * nearest-rank 法の `p` の百分位は「その値以下の要素が全体の `p` 割以上あり、かつそれを
 * 満たす最小の値」である。`summarizeTimings` は補間しないため、後半 (最小であること) は
 * 入力に含まれる値であることと合わせて確かめられる
 */
test("summarizeTimings: p50 / p95 以下に入力の p 割以上が収まる", () => {
  fc.assert(
    fc.property(valuesArbitrary(), (values) => {
      const summary = summarizeTimings(values);
      if (summary === null) {
        assert.equal(values.length, 0, "null を返すのは値が無いときだけであること");
        return;
      }
      const count = values.length;
      const atMostP50 = values.filter((value) => value <= summary.p50).length;
      const atMostP95 = values.filter((value) => value <= summary.p95).length;
      assert.isAtLeast(
        atMostP50 / count,
        0.5,
        `p50 (${summary.p50}) 以下が全体の半分以上であること`,
      );
      assert.isAtLeast(
        atMostP95 / count,
        0.95,
        `p95 (${summary.p95}) 以下が全体の 95 % 以上であること`,
      );
      assert.equal(
        values.filter((value) => value > summary.max).length,
        0,
        "max より大きい値が無いこと",
      );
    }),
    { numRuns: 300 },
  );
});
