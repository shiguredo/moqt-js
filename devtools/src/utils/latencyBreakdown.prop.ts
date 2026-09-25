/**
 * LatencyBreakdown の性質
 *
 * 描いたフレームごとに、区間 (到着・保留・復号待ち・復号・表示待ち) の和が表示の遅延と
 * 一致し、どの区間も負にならない。時刻は受信から描くまで前へ進む任意の列で確かめる。
 */

import { test, assert } from "vite-plus/test";
import * as fc from "fast-check";
import { LatencyBreakdown } from "./latencyBreakdown";

// 受信側の performance.timeOrigin (壁時計、Unix epoch ミリ秒)
const TIME_ORIGIN_MS = 1_790_263_445_000;
// 浮動小数点の誤差を許す幅 (ミリ秒)
const TOLERANCE_MS = 1e-6;

/** 1 枚のフレームの、前の時刻からの経過 (ミリ秒) */
const frameArbitrary = fc.record({
  // TIMESTAMP から受け取りまで (経路の遅延)
  arrivalMs: fc.integer({ min: 0, max: 2_000 }),
  holdMs: fc.integer({ min: 0, max: 100 }),
  decodeWaitMs: fc.integer({ min: 0, max: 100 }),
  decodeMs: fc.integer({ min: 0, max: 100 }),
  displayWaitMs: fc.integer({ min: 0, max: 600 }),
});

test("LatencyBreakdown: フレームごとに区間の和が表示の遅延と一致し、どの区間も負にならない", () => {
  fc.assert(
    fc.property(
      fc.array(frameArbitrary, { minLength: 1, maxLength: 100 }),
      fc.integer({ min: 1, max: 100 }),
      (frames, frameMs) => {
        const breakdown = new LatencyBreakdown(1_000_000, TIME_ORIGIN_MS);
        let lastDisplayedMs = 0;
        frames.forEach((frame, index) => {
          // TIMESTAMP はフレームごとに frameMs 進む (受信側の時刻で表す)
          const mediaMs = index * frameMs;
          const timestampMicros = (TIME_ORIGIN_MS + mediaMs) * 1_000;
          const receivedAtMs = mediaMs + frame.arrivalMs;
          const releasedAtMs = receivedAtMs + frame.holdMs;
          const decodeStartMs = releasedAtMs + frame.decodeWaitMs;
          const decodedAtMs = decodeStartMs + frame.decodeMs;
          const displayedAtMs = decodedAtMs + frame.displayWaitMs;
          breakdown.recordReceived(timestampMicros, receivedAtMs, true);
          breakdown.recordReleased(timestampMicros, releasedAtMs);
          breakdown.recordDecodeStart(timestampMicros, decodeStartMs);
          breakdown.recordDecodeOutput(timestampMicros, decodedAtMs);
          breakdown.recordDisplayed(timestampMicros, displayedAtMs);
          lastDisplayedMs = Math.max(lastDisplayedMs, displayedAtMs);
        });

        const values = breakdown.current(lastDisplayedMs);
        assert.equal(values.displayLatency.length, frames.length);
        values.displayLatency.forEach((displayLatencyMs, index) => {
          const sum =
            (values.arrival[index] ?? Number.NaN) +
            (values.hold[index] ?? Number.NaN) +
            (values.decodeWait[index] ?? Number.NaN) +
            (values.decode[index] ?? Number.NaN) +
            (values.displayWait[index] ?? Number.NaN);
          assert.closeTo(sum, displayLatencyMs, TOLERANCE_MS, `フレーム ${index} の区間の和`);
        });
        for (const series of Object.values(values)) {
          for (const value of series) {
            assert.isAtLeast(value, -TOLERANCE_MS);
          }
        }
      },
    ),
    { numRuns: 500 },
  );
});
