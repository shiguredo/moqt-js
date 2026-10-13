/**
 * dummy の映像の次に描くフレームの決め方 (nextDummyFrame) の Property-Based Tests
 *
 * タイマーが要求した時間より遅れて発火する状況を生成し、描く時刻を確かめる。
 *
 * - タイマーの遅れがフレーム間隔未満なら、フレームを飛ばさず、フレーム n を描く時刻は
 *   「開始 + n × フレーム間隔」から遅れの上限までに収まる (ずれが積み上がらない)
 */

import { test, assert } from "vite-plus/test";
import * as fc from "fast-check";
import { nextDummyFrame } from "./dummyVideo";

// 実際の framerate の範囲 (1 から 120 fps)
const framerateArbitrary = fc.integer({ min: 1, max: 120 });

test("nextDummyFrame: タイマーの遅れがフレーム間隔未満なら、フレームを飛ばさずずれも積み上がらない", () => {
  fc.assert(
    fc.property(
      framerateArbitrary,
      fc.double({ min: 0, max: 0.99, noNaN: true }),
      fc.array(fc.double({ min: 0, max: 1, noNaN: true }), { minLength: 1, maxLength: 300 }),
      (framerate, maxLatenessRatio, latenessRatios) => {
        const frameIntervalMs = 1_000 / framerate;
        const maxLatenessMs = frameIntervalMs * maxLatenessRatio;
        const startMs = 0;
        let nowMs = startMs;
        let frameIndex = 0;
        for (const ratio of latenessRatios) {
          const next = nextDummyFrame(startMs, frameIntervalMs, frameIndex, nowMs);
          assert.equal(next.frameIndex, frameIndex + 1, "フレームを飛ばさないこと");
          // タイマーは要求した時間の後、遅れの上限までに発火する
          nowMs += next.delayMs + maxLatenessMs * ratio;
          frameIndex = next.frameIndex;
          const dueMs = startMs + frameIndex * frameIntervalMs;
          assert.isAtLeast(nowMs, dueMs - 1e-6, "描く時刻の前に描かないこと");
          assert.isAtMost(nowMs, dueMs + maxLatenessMs + 1e-6, "遅れを積み上げないこと");
        }
      },
    ),
  );
});
