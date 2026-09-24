/**
 * メディア時刻から壁時計への換算の Property-Based Tests
 *
 * 取得元ごとに基準が異なるフレームの timestamp (マイクロ秒) を、最初のフレームを
 * 読んだときの壁時計に対応づけて換算する。換算がフレームの間隔を保つこと
 * (受信側が壁時計の差から到着の揺らぎや遅延を求められること) を確かめる。
 *
 * 境界値 (基準が 0 / 大きな値、負にしない) は mediaClock.test.ts の単体テストが固定する。
 */

import { test, assert } from "vite-plus/test";
import * as fc from "fast-check";
import { createWallClockAnchor, toWallClockMicroseconds } from "./mediaClock";

// 最初のフレームの timestamp (マイクロ秒)。0 から fake camera 相当 (約 80 時間) を超える範囲
const mediaMicrosArbitrary = fc.integer({ min: 0, max: 1_000_000_000_000 });
// 最初のフレームを読んだときの壁時計 (ミリ秒、端数を含む)。2020 年から 2100 年
const wallClockMillisArbitrary = fc.double({
  min: 1_577_836_800_000,
  max: 4_102_444_800_000,
  noNaN: true,
});
// 最初のフレームから後のフレームまでの差 (マイクロ秒)。最大 1 日
const offsetMicrosArbitrary = fc.integer({ min: 0, max: 86_400_000_000 });

test("toWallClockMicroseconds: 2 つのフレームの壁時計の差はメディア時刻の差と一致する", () => {
  fc.assert(
    fc.property(
      mediaMicrosArbitrary,
      wallClockMillisArbitrary,
      offsetMicrosArbitrary,
      offsetMicrosArbitrary,
      (firstMicros, wallClockMillis, offsetA, offsetB) => {
        const anchor = createWallClockAnchor(firstMicros, wallClockMillis);
        const a = toWallClockMicroseconds(firstMicros + offsetA, anchor);
        const b = toWallClockMicroseconds(firstMicros + offsetB, anchor);
        assert.equal(b - a, BigInt(offsetB - offsetA));
      },
    ),
  );
});

test("toWallClockMicroseconds: 最初のフレームは読んだときの壁時計 (マイクロ秒) になる", () => {
  fc.assert(
    fc.property(mediaMicrosArbitrary, wallClockMillisArbitrary, (firstMicros, wallClockMillis) => {
      const anchor = createWallClockAnchor(firstMicros, wallClockMillis);
      const converted = toWallClockMicroseconds(firstMicros, anchor);
      // マイクロ秒への丸めの誤差は 0.5 マイクロ秒以下
      assert.isAtMost(Math.abs(Number(converted) - wallClockMillis * 1000), 0.5);
      // 安全整数の範囲に収まり、受信側が Number にしても誤差が出ない
      assert.isTrue(Number.isSafeInteger(Number(converted)));
    }),
  );
});
