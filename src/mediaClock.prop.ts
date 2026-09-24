/**
 * メディア時刻から壁時計への換算 (WallClockMapper) の Property-Based Tests
 *
 * 一定の間隔で撮ったフレームを、任意の遅れで読み (observe)、encoder の遅れに相当する
 * 任意の順で換算する (toWallClockMicroseconds)。換算した TIMESTAMP について次を確かめる。
 *
 * - timestamp が増えれば、換算した TIMESTAMP も増える (単調)
 * - 換算した TIMESTAMP は、撮った時刻にそれまでに読んだフレームの最小の遅れを足した時刻
 *   より前にならない (撮った時刻より前にならない)
 * - 最小の遅れのフレームを読んだ後、十分な回数換算すると、換算した TIMESTAMP と撮った
 *   時刻の差は最小の遅れに収束する
 *
 * 境界値 (基準が大きな値、Unix epoch より前にしない) は mediaClock.test.ts の単体テストが
 * 固定する。
 */

import { test, assert } from "vite-plus/test";
import * as fc from "fast-check";
import { WallClockMapper } from "./mediaClock";

// メディア時刻 0 のフレームを撮った時刻 (壁時計、マイクロ秒)
const CAPTURE_ORIGIN_MICROS = 1_790_263_445_000_000;

/**
 * フレームの列。各フレームの読み取りの遅れ (マイクロ秒) と、読んでから換算までに
 * 読むフレームの数 (encoder の遅れ)
 */
const scenarioArbitrary = fc.record({
  frameMicros: fc.integer({ min: 4_000, max: 50_000 }),
  readDelaysMicros: fc.array(fc.integer({ min: 0, max: 500_000 }), {
    minLength: 1,
    maxLength: 120,
  }),
  encoderLag: fc.integer({ min: 0, max: 5 }),
});

/** 撮った時刻の壁時計 (ミリ秒) */
function captureMillis(frameMicros: number, index: number): number {
  return (CAPTURE_ORIGIN_MICROS + index * frameMicros) / 1_000;
}

test("WallClockMapper: 単調に増え、撮った時刻と最小の遅れより前にならない", () => {
  fc.assert(
    fc.property(scenarioArbitrary, ({ frameMicros, readDelaysMicros, encoderLag }) => {
      const mapper = new WallClockMapper();
      let previous: bigint | null = null;
      let minDelayMicros = Infinity;
      let converted = 0;
      const convert = (): void => {
        const mediaMicros = converted * frameMicros;
        const value = mapper.toWallClockMicroseconds(mediaMicros);
        if (previous !== null) {
          assert.isTrue(value > previous, `TIMESTAMP が戻った: ${previous} -> ${value}`);
        }
        const bias = Number(value) - (CAPTURE_ORIGIN_MICROS + mediaMicros);
        // 丸めの誤差 (1 マイクロ秒) を許す
        assert.isAtLeast(bias, minDelayMicros - 1);
        previous = value;
        converted++;
      };
      for (const [index, delayMicros] of readDelaysMicros.entries()) {
        mapper.observe(
          index * frameMicros,
          captureMillis(frameMicros, index) + delayMicros / 1_000,
        );
        minDelayMicros = Math.min(minDelayMicros, delayMicros);
        // encoder の遅れの分だけ前のフレームを換算する
        if (index - converted >= encoderLag) {
          convert();
        }
      }
      while (converted < readDelaysMicros.length) {
        convert();
      }
    }),
  );
});

test("WallClockMapper: 最小の遅れのフレームを読んだ後、十分に換算すると最小の遅れに収束する", () => {
  fc.assert(
    fc.property(scenarioArbitrary, ({ frameMicros, readDelaysMicros }) => {
      const mapper = new WallClockMapper();
      for (const [index, delayMicros] of readDelaysMicros.entries()) {
        mapper.observe(
          index * frameMicros,
          captureMillis(frameMicros, index) + delayMicros / 1_000,
        );
        mapper.toWallClockMicroseconds(index * frameMicros);
      }
      const minDelayMicros = Math.min(...readDelaysMicros);
      const maxDelayMicros = Math.max(...readDelaysMicros);
      // 1 回の換算で動かすのは timestamp の差の半分未満なので、差を埋めるのに要る回数だけ
      // 続けて換算する (読み取りの遅れは最小のフレームと同じ)
      const steps = Math.ceil((maxDelayMicros - minDelayMicros) / (frameMicros / 2)) + 2;
      let index = readDelaysMicros.length;
      let bias = Infinity;
      for (let step = 0; step < steps; step++, index++) {
        mapper.observe(
          index * frameMicros,
          captureMillis(frameMicros, index) + minDelayMicros / 1_000,
        );
        const value = mapper.toWallClockMicroseconds(index * frameMicros);
        bias = Number(value) - (CAPTURE_ORIGIN_MICROS + index * frameMicros);
      }
      assert.closeTo(bias, minDelayMicros, 1);
    }),
  );
});
