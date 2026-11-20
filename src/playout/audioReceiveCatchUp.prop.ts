import { assert } from "vite-plus/test";
import { test, fc } from "@fast-check/vitest";
import { AUDIO_RECEIVE_CATCH_UP_SKIP_MIN_MS, AudioReceiveCatchUp } from "./audioReceiveCatchUp";

const durationMsArbitrary = fc.oneof(fc.constant(2.5), fc.integer({ min: 3, max: 60 }));

test.prop([
  durationMsArbitrary,
  fc.array(
    fc.record({
      durationMs: durationMsArbitrary,
      gapMs: fc.oneof(fc.constantFrom(0, 0.5, 1, 2.5), fc.integer({ min: 2, max: 100 })),
    }),
    { minLength: 2, maxLength: 40 },
  ),
])("音声の長さが変わっても直前の終端から実際の欠落だけを数える", (firstDurationMs, frames) => {
  const catchUp = new AudioReceiveCatchUp();
  const originMicros = 1_800_000_000_000_000;
  catchUp.observe({ nowMs: 0, lagMs: 20, durationMs: 20, timestampMicros: originMicros });
  // 追いつきを始めてから、可変長の音声と媒体上の穴を渡す。壁時計は床の窓内に保つ。
  assert.isTrue(
    catchUp.observe({
      nowMs: 200,
      lagMs: 200,
      durationMs: firstDurationMs,
      timestampMicros: originMicros + 20_000,
    }).rebuildDecoder,
  );
  let mediaEndMs = 20 + firstDurationMs;
  let skippedMs = 0;
  for (const [index, frame] of frames.entries()) {
    const timestampMs = mediaEndMs + frame.gapMs;
    catchUp.observe({
      nowMs: 201 + index,
      lagMs: 200,
      durationMs: frame.durationMs,
      timestampMicros: originMicros + timestampMs * 1000,
    });
    // 閾値以内の差は timestamp の丸めとして扱う。
    if (frame.gapMs > AUDIO_RECEIVE_CATCH_UP_SKIP_MIN_MS) {
      skippedMs += frame.gapMs;
    }
    const stats = catchUp.snapshot();
    assert.isTrue(stats.catchingUp, "観測窓の中で追いつきを継続していること");
    assert.equal(stats.skippedMs, skippedMs, "可変長でも媒体上の穴の長さに一致すること");
    if (skippedMs === 0) {
      assert.equal(stats.skippedFrames, 0, "欠落がなければ件数も増やさないこと");
    }
    mediaEndMs = timestampMs + frame.durationMs;
  }
});
