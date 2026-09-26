/**
 * AudioPlayoutScheduler と AudioClockBridge の Property-Based Tests
 *
 * 届く時刻 (揺らぎ、まとまった到着、長い途切れ) と timestamp (音の抜け、進まない値、
 * 音の長さより短い間隔、大きな飛び) を任意に生成して通し、次の性質を固定する。
 *
 * - 目標を使わないとき (壁時計の TIMESTAMP を持たない音、音声だけを購読しているとき) は、
 *   鳴らすと決めた音が重ならず (前の音の終わりより前に鳴らさない)、鳴らす時刻は今 + 余裕
 *   以上、遅れ (鳴らす時刻 - 今) は「再生の遅れ + 余裕」以下
 * - 目標を守るときの判断は目標の時刻の上下限だけで決まる。早すぎても遅すぎても捨て、
 *   間なら目標の時刻そのもので鳴らす。外側の目標はさらに外側でも捨てる (単調)
 * - 目標を守るときは、窓の中かつ前の音の終わりより後ろの音を捨てない (捨てが連鎖しない)
 * - 時計の対応付けは、不感帯 (30 ms) 未満の差では動かず、1 回の変更は上限 (80 ms) まで。
 *   対応からの換算は往復する
 *
 * 個々の規則は audioPlayout.test.ts の単体テストが固定する。
 */

import { test, assert } from "vite-plus/test";
import * as fc from "fast-check";
import {
  AUDIO_CLOCK_DEADBAND_MS,
  AUDIO_CLOCK_MAX_CHANGE_MS,
  AUDIO_PLAYOUT_BACKLOG_SECONDS,
  AUDIO_PLAYOUT_DELAY_SECONDS,
  AUDIO_PLAYOUT_MAX_DELAY_SECONDS,
  AUDIO_PLAYOUT_MIN_LEAD_SECONDS,
  AudioClockBridge,
  AudioPlayoutScheduler,
  type AudioPlayoutTarget,
} from "./audioPlayout";

/** 浮動小数点の誤差を許す幅 (秒) */
const EPSILON = 1e-9;

/** 浮動小数点の誤差を許す幅 (ミリ秒) */
const EPSILON_MS = 1e-6;

/** 単調性を確かめるときに目標をさらに外側へ動かす幅 (秒) */
const FURTHER_SECONDS = AUDIO_PLAYOUT_MAX_DELAY_SECONDS;

/** 換算した値を取り出す (対応が無くて null のときは失敗にする) */
function valueOf(value: number | null): number {
  if (value === null) {
    throw new Error("expected a value, got null");
  }
  return value;
}

/** 目標を使わないときに受け取る再生の遅れ (秒)。共有の時間軸が決めた値 */
const delayArbitrary = fc.double({
  min: AUDIO_PLAYOUT_DELAY_SECONDS,
  max: AUDIO_PLAYOUT_MAX_DELAY_SECONDS,
  noNaN: true,
});

/** 目標を使わないときの 1 つの音: 前の音からの到着の間隔、timestamp の進み、音の長さ */
const frameArbitrary = fc.record({
  // 0 はまとまった到着、大きい値は長い途切れ
  arrivalGapSeconds: fc.oneof(
    fc.double({ min: 0, max: 0.05, noNaN: true }),
    fc.double({ min: 0, max: 0.5, noNaN: true }),
  ),
  // 0 は進まない timestamp (TIMESTAMP が無いなど)、20 ms より大きい値は音の抜け、
  // 10 秒の飛びは送る側の再起動
  timestampStepMicroseconds: fc.oneof(
    fc.constant(20_000),
    fc.constant(0),
    fc.integer({ min: 0, max: 100_000 }),
    fc.constant(10_000_000),
  ),
  durationSeconds: fc.oneof(fc.constant(0.02), fc.double({ min: 0.0025, max: 0.06, noNaN: true })),
});

/** 目標を守るときの 1 つの音: 今の時刻、目標のずれ (今からの秒)、音の長さ */
const enforcedScenarioArbitrary = fc.record({
  nowSeconds: fc.double({ min: 1, max: 1_000, noNaN: true }),
  delaySeconds: delayArbitrary,
  presentationDelaySeconds: delayArbitrary,
  minLeadSeconds: fc.double({ min: 0, max: AUDIO_PLAYOUT_MIN_LEAD_SECONDS, noNaN: true }),
  backlogSeconds: fc.double({
    min: AUDIO_PLAYOUT_BACKLOG_SECONDS / 2,
    max: AUDIO_PLAYOUT_BACKLOG_SECONDS * 2,
    noNaN: true,
  }),
  // 負は過ぎた目標、大きい値は並べすぎ
  offsetSeconds: fc.double({ min: -0.5, max: 1.5, noNaN: true }),
  durationSeconds: fc.oneof(fc.constant(0.02), fc.double({ min: 0.0025, max: 0.06, noNaN: true })),
});

/** 目標を守るときの音の列: 前の音からの到着の間隔、目標のずれ、音の長さ */
const enforcedFrameArbitrary = fc.record({
  arrivalGapSeconds: fc.oneof(
    fc.double({ min: 0, max: 0.05, noNaN: true }),
    fc.double({ min: 0, max: 0.5, noNaN: true }),
  ),
  offsetSeconds: fc.double({ min: -0.5, max: 1.5, noNaN: true }),
  durationSeconds: fc.oneof(fc.constant(0.02), fc.double({ min: 0.0025, max: 0.06, noNaN: true })),
});

/** 時計の対応付けの更新: 対応の有無と、そのときの 2 つの時計の値 */
const clockUpdateArbitrary = fc.record({
  contextTimeSeconds: fc.double({ min: 0, max: 100_000, noNaN: true }),
  performanceTimeMs: fc.double({ min: 0, max: 100_000_000, noNaN: true }),
  useMapping: fc.boolean(),
});

test("目標を使わないとき: 鳴らす音は重ならず、今 + 余裕以上、遅れは再生の遅れ + 余裕以下", () => {
  fc.assert(
    fc.property(
      delayArbitrary,
      fc.array(frameArbitrary, { minLength: 1, maxLength: 300 }),
      (delaySeconds, frames) => {
        const scheduler = new AudioPlayoutScheduler();
        const target: AudioPlayoutTarget = {
          targetStartSeconds: null,
          enforceTarget: false,
          delaySeconds,
          presentationDelaySeconds: delaySeconds,
        };
        let now = 100;
        let timestamp = 0;
        let previousEnd: number | null = null;
        for (const frame of frames) {
          now += frame.arrivalGapSeconds;
          timestamp += frame.timestampStepMicroseconds;
          const decision = scheduler.schedule(now, timestamp, frame.durationSeconds, target);
          if (decision.kind === "drop") {
            continue;
          }
          const { startAt } = decision;
          // 過ぎた時刻や、描画に間に合わない時刻を指定しない
          assert.isAtLeast(startAt, now + AUDIO_PLAYOUT_MIN_LEAD_SECONDS - EPSILON);
          // 並べすぎの上限は「再生の遅れ + 余裕」である
          assert.isAtMost(startAt - now, delaySeconds + AUDIO_PLAYOUT_BACKLOG_SECONDS + EPSILON);
          // 重ねると音が足されてノイズになる
          if (previousEnd !== null) {
            assert.isAtLeast(startAt, previousEnd - EPSILON);
          }
          previousEnd = startAt + frame.durationSeconds;
        }
      },
    ),
  );
});

test("目標を守るとき: 鳴らすか捨てるかは目標の時刻の上下限だけで決まる", () => {
  fc.assert(
    fc.property(enforcedScenarioArbitrary, (scenario) => {
      const limit = scenario.delaySeconds + scenario.backlogSeconds;
      const targetStartSeconds = scenario.nowSeconds + scenario.offsetSeconds;
      const makeScheduler = (): AudioPlayoutScheduler =>
        new AudioPlayoutScheduler({
          backlogSeconds: scenario.backlogSeconds,
          minLeadSeconds: scenario.minLeadSeconds,
        });
      const schedule = (scheduler: AudioPlayoutScheduler, seconds: number) =>
        scheduler.schedule(scenario.nowSeconds, 0, scenario.durationSeconds, {
          targetStartSeconds: seconds,
          enforceTarget: true,
          delaySeconds: scenario.delaySeconds,
          presentationDelaySeconds: scenario.delaySeconds,
        });
      const tooLate = targetStartSeconds < scenario.nowSeconds + scenario.minLeadSeconds;
      const tooFar = targetStartSeconds - scenario.nowSeconds > limit;
      const decision = schedule(makeScheduler(), targetStartSeconds);
      // 早すぎる (今 + 余裕より前) か、遅すぎる (今 + 再生の遅れ + 余裕より先) なら捨てる
      assert.equal(decision.kind, tooLate || tooFar ? "drop" : "play");
      if (decision.kind === "play") {
        // 鳴らすときは目標の時刻をそのまま使う (前後させると映像とずれる)
        assert.equal(decision.startAt, targetStartSeconds);
      }
      // 外側の目標は、さらに外側でも捨てる (捨てる判断は外側へ単調)
      if (tooLate) {
        assert.equal(schedule(makeScheduler(), targetStartSeconds - FURTHER_SECONDS).kind, "drop");
      } else if (tooFar) {
        assert.equal(schedule(makeScheduler(), targetStartSeconds + FURTHER_SECONDS).kind, "drop");
      }
    }),
  );
});

test("目標を守るとき: 鳴らす音は目標どおりで重ならず、窓の中の音は捨てない", () => {
  fc.assert(
    fc.property(fc.array(enforcedFrameArbitrary, { minLength: 1, maxLength: 300 }), (frames) => {
      const scheduler = new AudioPlayoutScheduler();
      const delaySeconds = AUDIO_PLAYOUT_DELAY_SECONDS;
      const limit = delaySeconds + AUDIO_PLAYOUT_BACKLOG_SECONDS;
      let now = 100;
      let previousEnd: number | null = null;
      for (const frame of frames) {
        now += frame.arrivalGapSeconds;
        const targetStartSeconds = now + frame.offsetSeconds;
        const decision = scheduler.schedule(now, 0, frame.durationSeconds, {
          targetStartSeconds,
          enforceTarget: true,
          delaySeconds,
          presentationDelaySeconds: delaySeconds,
        });
        const tooLate = targetStartSeconds < now + AUDIO_PLAYOUT_MIN_LEAD_SECONDS;
        const tooFar = targetStartSeconds - now > limit;
        const overlaps = previousEnd !== null && targetStartSeconds < previousEnd;
        if (decision.kind === "play") {
          // 鳴らすと決めた音は目標の時刻そのもので、窓の中にあり、前の音と重ならない
          assert.equal(decision.startAt, targetStartSeconds);
          assert.isFalse(tooLate);
          assert.isFalse(tooFar);
          assert.isFalse(overlaps);
          previousEnd = decision.startAt + frame.durationSeconds;
        } else {
          // 窓の中かつ前の音の終わりより後ろの音は捨てない (捨てが連鎖しない)
          assert.isTrue(tooLate || tooFar || overlaps);
        }
      }
    }),
  );
});

test("AudioClockBridge: 対応付けは不感帯未満では動かず、1 回の変更は上限まで", () => {
  fc.assert(
    fc.property(fc.array(clockUpdateArbitrary, { minLength: 1, maxLength: 100 }), (updates) => {
      const bridge = new AudioClockBridge();
      let previousOffsetMs: number | null = null;
      for (const update of updates) {
        bridge.update(
          update.useMapping
            ? { contextTime: update.contextTimeSeconds, performanceTime: update.performanceTimeMs }
            : null,
          update.contextTimeSeconds,
          update.performanceTimeMs,
        );
        const offsetMs = valueOf(bridge.currentOffsetMs);
        if (previousOffsetMs !== null) {
          // 動かないか、不感帯 (30 ms) 以上で上限 (80 ms) 以下だけ動く
          const changeMs = Math.abs(offsetMs - previousOffsetMs);
          assert.isTrue(
            changeMs < EPSILON_MS ||
              (changeMs >= AUDIO_CLOCK_DEADBAND_MS - EPSILON_MS &&
                changeMs <= AUDIO_CLOCK_MAX_CHANGE_MS + EPSILON_MS),
          );
        }
        // 代用しているかどうかは、最後に渡した対応で決まる
        assert.equal(bridge.usingFallback, !update.useMapping);
        previousOffsetMs = offsetMs;
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
