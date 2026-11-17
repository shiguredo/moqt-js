import { assert } from "vite-plus/test";
import { test, fc } from "@fast-check/vitest";
import { AudioReceiveCatchUp } from "./audioReceiveCatchUp";

test.prop([
  fc.array(
    fc.record({
      durationMs: fc.integer({ min: 3, max: 60 }),
      gapMs: fc.oneof(fc.constant(0), fc.integer({ min: 2, max: 100 })),
    }),
    { minLength: 2, maxLength: 40 },
  ),
])("音声の長さが変わっても直前の終端から実際の欠落だけを数える", (frames) => {
  const catchUp = new AudioReceiveCatchUp();
  catchUp.observe({ nowMs: 0, lagMs: 20, durationMs: 20, timestampMicros: 0 });
  // 追いつきを始めてから、可変長の音声と媒体上の穴を渡す。壁時計は床の窓内に保つ。
  assert.isTrue(
    catchUp.observe({ nowMs: 200, lagMs: 200, durationMs: 20, timestampMicros: 20_000 })
      .rebuildDecoder,
  );
  let mediaEndMs = 40;
  let skippedMs = 0;
  for (const [index, frame] of frames.entries()) {
    const timestampMs = mediaEndMs + frame.gapMs;
    catchUp.observe({
      nowMs: 201 + index,
      lagMs: 200,
      durationMs: frame.durationMs,
      timestampMicros: timestampMs * 1000,
    });
    skippedMs += frame.gapMs;
    assert.equal(
      catchUp.snapshot().skippedMs,
      skippedMs,
      "可変長でも媒体上の穴の長さに一致すること",
    );
    mediaEndMs = timestampMs + frame.durationMs;
  }
});
