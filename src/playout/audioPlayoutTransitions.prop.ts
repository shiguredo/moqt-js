/** 再生基準が切り替わっても、先行予約を追い越して音を重ねない。 */
import { assert } from "vite-plus/test";
import { test, fc } from "@fast-check/vitest";
import { AudioPlayoutScheduler } from "./audioPlayout";

test.prop([fc.integer({ min: 50, max: 200 }), fc.integer({ min: 3, max: 20 })], {
  numRuns: 100,
})("時刻基準から初めて到着基準へ移っても予約の順序を保つ", (targetMs, durationMs) => {
  const scheduler = new AudioPlayoutScheduler();
  const duration = durationMs / 1000;
  let previousEnd = 0;
  for (let index = 0; index < 6; index++) {
    const now = index * duration;
    const decision = scheduler.schedule(now, index * durationMs * 1000, duration, {
      targetStartSeconds: index === 0 ? targetMs / 1000 : null,
      enforceTarget: index === 0,
      arrivalSeconds: now,
      arrivalDelaySeconds: 0.05,
      delaySeconds: targetMs / 1000,
      presentationDelaySeconds: targetMs / 1000,
    });
    assert.equal(decision.kind, "play");
    if (decision.kind !== "play") return;
    assert.isAtLeast(decision.startAt + 1e-9, previousEnd, "先行予約と重ならないこと");
    // 波形が圧縮できない場合も、実際の長さを次の予約へ引き継ぐ。
    scheduler.confirmStretch(0);
    previousEnd = decision.startAt + duration;
  }
});
