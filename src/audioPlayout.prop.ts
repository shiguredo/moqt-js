/**
 * AudioPlayoutScheduler の Property-Based Tests
 *
 * 届く時刻 (揺らぎ、まとまった到着、長い途切れ) と timestamp (音の抜け、進まない値、
 * 音の長さより短い間隔) を任意に生成して通し、次の性質を固定する。
 *
 * - 鳴らすと決めた音は重ならない (前の音の終わりより前に鳴らさない)。重なると音が足されて
 *   ノイズになる
 * - 鳴らす時刻は今 + 余裕以上 (過ぎた時刻や、描画に間に合わない時刻を指定しない)
 * - 遅れ (鳴らす時刻 - 今) は上限以下
 *
 * 個々の規則は audioPlayout.test.ts の単体テストが固定する。
 */

import { test, assert } from "vite-plus/test";
import * as fc from "fast-check";
import {
  AUDIO_PLAYOUT_MAX_DELAY_SECONDS,
  AUDIO_PLAYOUT_MIN_LEAD_SECONDS,
  AudioPlayoutScheduler,
} from "./audioPlayout";

/** 浮動小数点の誤差を許す幅 (秒) */
const EPSILON = 1e-9;

/** 1 つの音: 前の音からの到着の間隔、timestamp の進み、音の長さ */
const frameArbitrary = fc.record({
  // 0 はまとまった到着、大きい値は長い途切れ
  arrivalGapSeconds: fc.oneof(
    fc.double({ min: 0, max: 0.05, noNaN: true }),
    fc.double({ min: 0, max: 0.5, noNaN: true }),
  ),
  // 0 は進まない timestamp (TIMESTAMP が無いなど)、20 ms より大きい値は音の抜け
  timestampStepMicroseconds: fc.oneof(
    fc.constant(20_000),
    fc.constant(0),
    fc.integer({ min: 0, max: 100_000 }),
  ),
  durationSeconds: fc.oneof(fc.constant(0.02), fc.double({ min: 0.0025, max: 0.06, noNaN: true })),
});

test("鳴らす音は重ならず、今 + 余裕以上、遅れは上限以下になる", () => {
  fc.assert(
    fc.property(fc.array(frameArbitrary, { minLength: 1, maxLength: 300 }), (frames) => {
      const scheduler = new AudioPlayoutScheduler();
      let now = 100;
      let timestamp = 0;
      let previousEnd: number | null = null;
      for (const frame of frames) {
        now += frame.arrivalGapSeconds;
        timestamp += frame.timestampStepMicroseconds;
        const decision = scheduler.schedule(now, timestamp, frame.durationSeconds);
        if (decision.kind === "drop") {
          continue;
        }
        const { startAt } = decision;
        assert.isAtLeast(startAt, now + AUDIO_PLAYOUT_MIN_LEAD_SECONDS - EPSILON);
        assert.isAtMost(startAt - now, AUDIO_PLAYOUT_MAX_DELAY_SECONDS + EPSILON);
        if (previousEnd !== null) {
          assert.isAtLeast(startAt, previousEnd - EPSILON);
        }
        previousEnd = startAt + frame.durationSeconds;
      }
    }),
  );
});
