/** 再生基準が切り替わっても、先行予約を追い越して音を重ねない。 */
import { assert } from "vite-plus/test";
import { test, fc } from "@fast-check/vitest";
import { AudioPlayoutScheduler } from "./audioPlayout";

test.prop(
  [fc.integer({ min: 50, max: 200 }), fc.integer({ min: 3, max: 20 }), fc.constantFrom(0, 0.5, 1)],
  {
    numRuns: 100,
  },
)(
  "時刻基準から到着基準へ移り、圧縮を適用しても予約の順序と連続性を保つ",
  (targetMs, durationMs, appliedRatio) => {
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
      const applied = decision.compressSeconds * appliedRatio;
      scheduler.commit(decision, { startAt: decision.startAt, playedSeconds: duration - applied });
      if (index >= 2)
        assert.closeTo(decision.startAt, previousEnd, 1e-9, "圧縮を anchor に反映すること");
      previousEnd = decision.startAt + duration - applied;
    }
  },
);
