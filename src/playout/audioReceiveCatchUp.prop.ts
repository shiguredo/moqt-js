/** 可変長の音声でも、追いつきで飛んだ媒体時間だけを数える。 */
import { test, assert } from "vite-plus/test";
import * as fc from "fast-check";
import { AUDIO_RECEIVE_CATCH_UP_SKIP_MIN_MS, AudioReceiveCatchUp } from "./audioReceiveCatchUp";

const durationMsArbitrary = fc.constantFrom(2.5, 5, 10, 20, 40, 60);
const framesArbitrary = fc.array(
  fc.record({
    durationMs: durationMsArbitrary,
    gapMs: fc.constantFrom(0, 0.5, 1, 2.5, 5, 10, 20, 40, 60, 100),
  }),
  { minLength: 1, maxLength: 10 },
);

test("AudioReceiveCatchUp: 音声の長さが変わっても実際の媒体の穴だけを数える", () => {
  fc.assert(
    fc.property(durationMsArbitrary, framesArbitrary, (firstDurationMs, frames) => {
      const catchUp = new AudioReceiveCatchUp();
      const originMicros = 1_800_000_000_000_000;
      catchUp.observe({ nowMs: 0, lagMs: 20, durationMs: 20, timestampMicros: originMicros });
      let timestampMicros = originMicros + 20_000;
      const started = catchUp.observe({
        nowMs: 200,
        lagMs: 200,
        durationMs: firstDurationMs,
        timestampMicros,
      });
      assert.isTrue(started.rebuildDecoder);
      let previousDurationMs = firstDurationMs;
      let expectedSkippedMs = 0;
      for (const frame of frames) {
        // 前の音の終端から gapMs だけ空けて次を始める。今回の長さは、この穴と独立である。
        timestampMicros += (previousDurationMs + frame.gapMs) * 1000;
        catchUp.observe({
          nowMs: (timestampMicros - originMicros) / 1000 + 180,
          lagMs: 200,
          durationMs: frame.durationMs,
          timestampMicros,
        });
        if (frame.gapMs > AUDIO_RECEIVE_CATCH_UP_SKIP_MIN_MS) expectedSkippedMs += frame.gapMs;
        previousDurationMs = frame.durationMs;
        const stats = catchUp.snapshot();
        assert.isTrue(stats.catchingUp, "観測窓の中で追いつきを継続していること");
        assert.closeTo(stats.skippedMs, expectedSkippedMs, 1e-8, "媒体の穴の合計だけを数えること");
        if (expectedSkippedMs === 0)
          assert.equal(stats.skippedFrames, 0, "欠落が無ければ件数も増やさないこと");
      }
    }),
    { numRuns: 200 },
  );
});
