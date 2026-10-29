/** 遅延を増やす根拠を到着と実出力に限定し、入力の欠落や過去の待ちで積み上げない。 */
import { assert } from "vite-plus/test";
import { test, fc } from "@fast-check/vitest";
import { PlayoutTimeline } from "./timeline";

test.prop(
  [
    fc.array(
      fc.record({
        jitterMs: fc.integer({ min: 0, max: 80 }),
        leadMs: fc.integer({ min: 0, max: 150 }),
      }),
      { minLength: 100, maxLength: 250 },
    ),
  ],
  { numRuns: 40 },
)("出力時計と到着の任意の揺らぎでも、音声の予算は有限な 50〜100 ms に収まる", (arrivals) => {
  const timeline = new PlayoutTimeline({ timeOriginMs: 0, maxQueuedFrames: 24 });
  let previousArrivalMs = 0;
  for (const [index, row] of arrivals.entries()) {
    const timestampMs = 1000 + index * 20;
    const arrivalMs = Math.max(previousArrivalMs + 0.1, timestampMs + row.jitterMs);
    previousArrivalMs = arrivalMs;
    timeline.observe("audio", arrivalMs, timestampMs * 1000);
    timeline.observeAudioOutputLead(row.leadMs, arrivalMs);
    const delay = timeline.audioDelayStats();
    assert.isTrue(Number.isFinite(delay.targetMs));
    assert.isAtLeast(delay.targetMs, 50);
    assert.isAtMost(delay.targetMs, 100);
    assert.isAtLeast(delay.outputLeadMs ?? -1, 0);
    assert.isAtMost(delay.outputLeadMs ?? Infinity, 150);
  }
});

test.prop([fc.array(fc.boolean(), { minLength: 100, maxLength: 300 })], { numRuns: 40 })(
  "媒体が欠落しても正常な到着の予算と同期を変えない",
  (losses) => {
    const timeline = new PlayoutTimeline({ timeOriginMs: 0, maxQueuedFrames: 24 });
    for (const [index, lost] of losses.entries()) {
      const mediaMs = 1000 + index * 20;
      timeline.observe("video", mediaMs + 20, mediaMs * 1000);
      if (!lost) {
        timeline.observe("audio", mediaMs + 20, mediaMs * 1000);
        timeline.observeAudioOutputLead(43, mediaMs + 20);
        assert.closeTo(timeline.audioDelayStats().targetMs, 50, 0.01);
        const { audio, video } = timeline.delayBreakdown;
        assert.isAtMost(
          Math.abs((audio.presentationDelayMs ?? 0) - (video.presentationDelayMs ?? 0)),
          5.01,
        );
      }
    }
  },
);
