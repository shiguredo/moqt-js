/** 出力時計で通知された量だけを累積し、不正な通知で計器を壊さない。 */
import { test, assert } from "vite-plus/test";
import { AudioPlayoutScheduler } from "./audioPlayout";
import { AudioPlayoutTimingStats } from "./audioPlayoutTimingStats";

test("実出力の補間と未補間の通知を累積する", () => {
  const scheduler = new AudioPlayoutScheduler();
  scheduler.recordRenderedConcealment(0.02, 1);
  scheduler.recordRenderedConcealment(0.01, 0);
  assert.closeTo(scheduler.concealed, 0.03, 1e-12);
  assert.equal(scheduler.concealments, 1);
  scheduler.recordRenderedConcealment(Number.NaN, 1);
  scheduler.recordRenderedConcealment(-1, 1);
  assert.closeTo(scheduler.concealed, 0.03, 1e-12);
  const timing = new AudioPlayoutTimingStats(10000, 0);
  timing.recordRenderedGap(10, 1);
  timing.recordRenderedGap(20, 0);
  timing.recordRenderedGap(Number.NaN, 1);
  assert.equal(timing.snapshot(0).gapMs, 30);
  assert.equal(timing.snapshot(0).gapCount, 1);
});
