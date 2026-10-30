/** 遅延を増やす根拠を到着と実出力に限定し、入力の欠落や過去の待ちで積み上げない。 */
import { assert } from "vite-plus/test";
import { test, fc } from "@fast-check/vitest";
import { PlayoutTimeline } from "./timeline";

test.prop([fc.constantFrom(20, 30, 50, 60, 120), fc.integer({ min: 20, max: 140 })], {
  numRuns: 40,
})("起動から周期的な揺らぎが続いても、初期判定で学習を止め続けない", (fps, jitterMs) => {
  const timeline = new PlayoutTimeline({ timeOriginMs: 0, maxQueuedFrames: 24 });
  let previousArrivalMs = 0;
  for (let index = 0; index < fps * 3; index++) {
    const mediaMs = (index * 1000) / fps;
    // 遅着の後も出力順と壁時計の単調性を保つ。ピークだけが通常間隔になる場合も含む。
    const arrivalMs = Math.max(
      previousArrivalMs + 0.1,
      mediaMs + 20 + (index % 3 === 2 ? jitterMs : 0),
    );
    previousArrivalMs = arrivalMs;
    timeline.observe("audio", arrivalMs, Math.round(mediaMs * 1000));
    timeline.observeAudioOutputLead(43, arrivalMs);
  }
  assert.closeTo(timeline.audioDelayStats().jitterMs ?? 0, jitterMs, 0.02);
});

test.prop(
  [
    fc.constantFrom(20, 30, 50, 60, 120),
    fc.integer({ min: 220, max: 800 }),
    fc.constantFrom("audio" as const, "video" as const),
  ],
  { numRuns: 50 },
)(
  "起動中の一度の停滞が解消したら、配信周期にかかわらず初期の待ちを保持しない",
  (fps, stallMs, stream) => {
    const timeline = new PlayoutTimeline({ timeOriginMs: 0, maxQueuedFrames: 24 });
    let previousArrivalMs = 0;
    // 実クラスへの入力時刻だけを変える。復帰時は媒体の順を保って一度に到着する。
    for (let index = 0; (index * 1000) / fps <= 100 + stallMs + 600; index++) {
      const mediaMs = (index * 1000) / fps;
      const extraMs = mediaMs >= 100 && mediaMs < 100 + stallMs ? 100 + stallMs - mediaMs : 0;
      const arrivalMs = Math.max(previousArrivalMs + 0.1, mediaMs + 20 + extraMs);
      previousArrivalMs = arrivalMs;
      timeline.observe(stream, arrivalMs, Math.round(mediaMs * 1000));
      if (stream === "audio") timeline.observeAudioOutputLead(43, arrivalMs);
    }
    if (stream === "audio") assert.closeTo(timeline.audioDelayStats().targetMs, 50, 0.02);
    else assert.isAtMost(timeline.videoDelayMs ?? Infinity, 0.02);
  },
);

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
