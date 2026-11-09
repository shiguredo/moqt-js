/** 受理した実音だけを確定し、任意の到着・媒体飛び・伸縮・再生基準で上限を保つ。 */
import { test, assert } from "vite-plus/test";
import * as fc from "fast-check";
import {
  AudioPlayoutScheduler,
  AudioClockBridge,
  AUDIO_CLOCK_MAX_CHANGE_MS,
  AUDIO_CLOCK_STALL_MS,
} from "./audioPlayout";

const EPSILON = 1e-9;
const EPSILON_MS = 1e-6;
function valueOf(value: number | null): number {
  assert.isNotNull(value);
  return value ?? 0;
}
const clockUpdateArbitrary = fc.record({
  contextTimeSeconds: fc.double({ min: 0, max: 100000, noNaN: true }),
  performanceTimeMs: fc.double({ min: 0, max: 100000000, noNaN: true }),
  useMapping: fc.boolean(),
});

test("計画と実投入が異なっても有限な予約終端・非重複・保持量の上限を保つ", () => {
  fc.assert(
    fc.property(
      fc.array(
        fc.record({
          arrivalMs: fc.integer({ min: 0, max: 120 }),
          mediaMs: fc.integer({ min: -20, max: 200 }),
          durationMs: fc.integer({ min: 3, max: 60 }),
          targetMs: fc.integer({ min: -1000, max: 400 }),
          timestampBasis: fc.boolean(),
          appliedPercent: fc.integer({ min: 0, max: 100 }),
          committed: fc.boolean(),
        }),
        { minLength: 100, maxLength: 300 },
      ),
      (frames) => {
        const scheduler = new AudioPlayoutScheduler();
        let compressed = 0,
          end = 0,
          expanded = 0,
          now = 1,
          timestamp = 0;
        for (const frame of frames) {
          now += frame.arrivalMs / 1000;
          timestamp += frame.mediaMs * 1000;
          const duration = frame.durationMs / 1000;
          const decision = scheduler.schedule(now, timestamp, duration, {
            targetStartSeconds: frame.timestampBasis ? now + frame.targetMs / 1000 : null,
            enforceTarget: frame.timestampBasis,
            arrivalSeconds: now,
            delaySeconds: 0.05,
            arrivalDelaySeconds: 0.05,
            presentationDelaySeconds: 0.05,
          });
          if (decision.kind === "drop") continue;
          assert.isAtLeast(decision.startAt, end - EPSILON);
          assert.isAtLeast(decision.startAt, now + 0.0095 - EPSILON);
          assert.isAtMost(decision.startAt + duration - now, 0.3 + EPSILON);
          assert.isAtMost(decision.compressSeconds, duration / 2 + EPSILON);
          assert.isAtMost(decision.expandSeconds ?? 0, duration + EPSILON);
          assert.equal(decision.compressSeconds * (decision.expandSeconds ?? 0), 0);
          if (!frame.committed) continue;
          const change =
            (((decision.expandSeconds ?? 0) - decision.compressSeconds) * frame.appliedPercent) /
            100;
          const playedSeconds = duration + change;
          end = decision.startAt + playedSeconds;
          scheduler.commit(decision, { startAt: decision.startAt, playedSeconds });
          compressed += Math.max(0, -change);
          expanded += Math.max(0, change);
          assert.isAtMost(end - now, 0.3 + EPSILON);
          assert.closeTo(scheduler.compressed, compressed, EPSILON);
          assert.closeTo(scheduler.expanded, expanded, EPSILON);
        }
      },
    ),
    { numRuns: 100 },
  );
});

test("AudioClockBridge: 対応付けの 1 回の変更は上限まで", () => {
  fc.assert(
    fc.property(fc.array(clockUpdateArbitrary, { minLength: 1, maxLength: 100 }), (updates) => {
      const bridge = new AudioClockBridge();
      let previousOffsetMs: number | null = null;
      let previousCurrentTimeSeconds: number | null = null;
      let previousPerformanceTimeMs: number | null = null;
      let previousUseMapping: boolean | null = null;
      for (const update of updates) {
        // 停止の判定はブリッジと同じ材料 (前回からの 2 つの時計の進み) で行う
        const audioElapsedMs =
          previousCurrentTimeSeconds === null
            ? null
            : (update.contextTimeSeconds - previousCurrentTimeSeconds) * 1_000;
        const performanceElapsedMs =
          previousPerformanceTimeMs === null
            ? null
            : update.performanceTimeMs - previousPerformanceTimeMs;
        const stalled =
          audioElapsedMs !== null &&
          performanceElapsedMs !== null &&
          audioElapsedMs >= 0 &&
          performanceElapsedMs - audioElapsedMs >= AUDIO_CLOCK_STALL_MS;
        bridge.update(
          update.useMapping
            ? { contextTime: update.contextTimeSeconds, performanceTime: update.performanceTimeMs }
            : null,
          update.contextTimeSeconds,
          update.performanceTimeMs,
        );
        const offsetMs = valueOf(bridge.currentOffsetMs);
        if (previousOffsetMs !== null) {
          if (stalled || previousUseMapping !== update.useMapping) {
            // 停止を検出したときは、段差を分割せず観測値そのものを採る
            const observedMs = update.contextTimeSeconds * 1_000 - update.performanceTimeMs;
            assert.closeTo(
              offsetMs,
              observedMs,
              Math.max(1, Math.abs(observedMs)) * 1e-9,
              "停止の段差をそのまま取り直すこと",
            );
          } else {
            // 新しい観測へ向けて上限以内で動き、同一または古い観測では動かない。
            const changeMs = Math.abs(offsetMs - previousOffsetMs);
            assert.isAtMost(changeMs, AUDIO_CLOCK_MAX_CHANGE_MS + EPSILON_MS);
          }
        }
        // 代用しているかどうかは、最後に渡した対応で決まる
        assert.equal(bridge.usingFallback, !update.useMapping);
        previousOffsetMs = offsetMs;
        previousCurrentTimeSeconds = update.contextTimeSeconds;
        previousPerformanceTimeMs = update.performanceTimeMs;
        previousUseMapping = update.useMapping;
      }
    }),
  );
});

test("AudioClockBridge: 対応から換算した値は元の軸に戻る", () => {
  fc.assert(
    fc.property(
      fc.double({ min: 0, max: 100_000, noNaN: true }),
      fc.double({ min: 0, max: 100_000_000, noNaN: true }),
      fc.double({ min: 0, max: 10_000_000, noNaN: true }),
      (contextTimeSeconds, performanceTimeMs, presentationMs) => {
        const bridge = new AudioClockBridge();
        bridge.update(
          { contextTime: contextTimeSeconds, performanceTime: performanceTimeMs },
          contextTimeSeconds,
          performanceTimeMs,
        );
        const audioSeconds = valueOf(bridge.toAudioSeconds(presentationMs));
        const roundTripped = valueOf(bridge.toPerformanceMs(audioSeconds));
        // 往復の精度は、換算に使う対応 (offsetMs) の大きさで決まる。offsetMs は
        // contextTime * 1000 - performanceTime なので performanceTime と同じ桁になりうる
        const offsetMs = Math.abs(valueOf(bridge.currentOffsetMs));
        assert.closeTo(roundTripped, presentationMs, Math.max(1, presentationMs, offsetMs) * 1e-9);
      },
    ),
  );
});

test("AudioClockBridge: reset 直後の update は前の対応に依存せず観測値を採る", () => {
  fc.assert(
    fc.property(
      fc.array(clockUpdateArbitrary, { minLength: 1, maxLength: 100 }),
      clockUpdateArbitrary,
      (updates, last) => {
        const bridge = new AudioClockBridge();
        // reset の前に好きなだけ対応を動かす (不感帯の据え置きと上限の頭打ちを含む)
        for (const update of updates) {
          bridge.update(
            update.useMapping
              ? {
                  contextTime: update.contextTimeSeconds,
                  performanceTime: update.performanceTimeMs,
                }
              : null,
            update.contextTimeSeconds,
            update.performanceTimeMs,
          );
        }

        bridge.reset();
        // 対応が無くなる (次の update は前の値との比較をしない)
        assert.isNull(bridge.currentOffsetMs);

        const mapping = last.useMapping
          ? { contextTime: last.contextTimeSeconds, performanceTime: last.performanceTimeMs }
          : null;
        bridge.update(mapping, last.contextTimeSeconds, last.performanceTimeMs);

        // 前の対応との差ではなく、観測値そのものを採る (据え置きも頭打ちも無い)
        const observedMs =
          mapping === null
            ? last.contextTimeSeconds * 1_000 - last.performanceTimeMs
            : mapping.contextTime * 1_000 - mapping.performanceTime;
        assert.closeTo(
          valueOf(bridge.currentOffsetMs),
          observedMs,
          Math.max(1, Math.abs(observedMs)) * 1e-9,
        );
        // 代用の印も、最後に渡した対応だけで決まる
        assert.equal(bridge.usingFallback, !last.useMapping);
      },
    ),
  );
});

test("AudioClockBridge: 定常誤差への収束は新規観測の頻度に依存しない", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 100 }),
      fc.integer({ min: -25, max: 25 }),
      (intervalMs, offsetMs) => {
        const run = (interval: number): number => {
          const bridge = new AudioClockBridge();
          bridge.update({ contextTime: 1, performanceTime: 1000 }, 1.03, 1000);
          // 同じ 1 秒の出力観測を違う粒度で与える。再読ではなく、新しい時計対応で比較する。
          for (let elapsed = interval; elapsed < 1000; elapsed += interval) {
            bridge.update(
              { contextTime: (1000 + elapsed + offsetMs) / 1000, performanceTime: 1000 + elapsed },
              (1030 + elapsed) / 1000,
              1000 + elapsed,
            );
          }
          bridge.update(
            { contextTime: (2000 + offsetMs) / 1000, performanceTime: 2000 },
            2.03,
            2000,
          );
          return valueOf(bridge.currentOffsetMs);
        };
        assert.closeTo(run(intervalMs), run(1), 1e-6);
        assert.closeTo(run(intervalMs), offsetMs, 0.01);
      },
    ),
  );
});
