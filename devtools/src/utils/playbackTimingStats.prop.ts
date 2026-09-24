/**
 * PlaybackTimingStats の Property-Based Tests
 *
 * 到着・復号・表示の記録を任意の時刻の列として生成し、統計が満たすべき性質を確かめる。
 *
 * - 分布は窓の中の値だけから求める (実装と独立したモデルと比べる)
 * - 到着の揺らぎは送信側と受信側の時計のずれに依らない
 * - 累積の値 (止まりの回数と時間、表示キューのあふれ) は減らない
 * - 表示間隔がフレーム間隔どおりなら止まりは 0 である
 *
 * 境界値 (百分位の定義、復号時間の対応づけ、リセット) は playbackTimingStats.test.ts の
 * 単体テストが固定する。
 */

import { test, assert } from "vite-plus/test";
import * as fc from "fast-check";
import {
  PLAYBACK_TIMING_WINDOW_MS,
  PlaybackTimingStats,
  type TimingSummary,
} from "./playbackTimingStats";

/**
 * 実装と独立した百分位のモデル (nearest-rank 法)
 */
function modelSummary(values: number[]): TimingSummary | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const at = (ratio: number): number =>
    sorted[Math.max(0, Math.ceil(ratio * sorted.length) - 1)] ?? Number.NaN;
  return { p50: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1] ?? Number.NaN };
}

/**
 * 到着の記録 (直前の到着からの経過ミリ秒、メディア時刻の遅れミリ秒、送信側の時計のずれ)
 */
const arrivalsArbitrary = fc.array(
  fc.record({
    elapsedMs: fc.integer({ min: 0, max: 3_000 }),
    delayMs: fc.integer({ min: 0, max: 2_000 }),
  }),
  { minLength: 1, maxLength: 60 },
);

test("snapshot: 到着の揺らぎと遅延は窓の中の到着だけから求める", () => {
  fc.assert(
    fc.property(arrivalsArbitrary, fc.integer({ min: 0, max: 5_000 }), (arrivals, tailMs) => {
      const stats = new PlaybackTimingStats();
      // 受信側の時刻 (ms) と、送信側の壁時計のメディア時刻 (µs)
      const recorded: { nowMs: number; latencyMs: number }[] = [];
      let nowMs = 0;
      for (const { elapsedMs, delayMs } of arrivals) {
        nowMs += elapsedMs;
        // 到着はメディア時刻から delayMs 遅れる。壁時計は受信側の時刻と同じ原点にする
        const mediaMs = nowMs - delayMs;
        stats.recordArrival(nowMs, mediaMs * 1_000, nowMs);
        recorded.push({ nowMs, latencyMs: delayMs });
      }
      const snapshotAt = nowMs + tailMs;
      const inWindow = recorded.filter(
        (entry) => entry.nowMs >= snapshotAt - PLAYBACK_TIMING_WINDOW_MS,
      );
      const snapshot = stats.snapshot(snapshotAt);
      const latencies = inWindow.map((entry) => entry.latencyMs);
      assert.deepEqual(snapshot.latencyMs, modelSummary(latencies));
      const minimum = Math.min(...latencies);
      assert.deepEqual(
        snapshot.arrivalJitterMs,
        modelSummary(latencies.map((latency) => latency - minimum)),
      );
    }),
  );
});

test("snapshot: 到着の揺らぎは送信側と受信側の時計のずれに依らない", () => {
  fc.assert(
    fc.property(
      arrivalsArbitrary,
      fc.integer({ min: -1_000_000_000, max: 1_000_000_000 }),
      (arrivals, clockOffsetMs) => {
        const aligned = new PlaybackTimingStats();
        const shifted = new PlaybackTimingStats();
        let nowMs = 0;
        for (const { elapsedMs, delayMs } of arrivals) {
          nowMs += elapsedMs;
          const mediaMs = nowMs - delayMs;
          aligned.recordArrival(nowMs, mediaMs * 1_000, null);
          // 送信側の時計が clockOffsetMs ずれている
          shifted.recordArrival(nowMs, (mediaMs + clockOffsetMs) * 1_000, null);
        }
        assert.deepEqual(
          shifted.snapshot(nowMs).arrivalJitterMs,
          aligned.snapshot(nowMs).arrivalJitterMs,
        );
      },
    ),
  );
});

/**
 * 表示の記録 (直前の表示からの経過ミリ秒と、メディア時刻の進みのフレーム数) と
 * 表示キューのあふれ
 */
const displayEventsArbitrary = fc.array(
  fc.oneof(
    fc.record({
      kind: fc.constant("display" as const),
      elapsedMs: fc.integer({ min: 0, max: 2_000 }),
      frames: fc.integer({ min: 0, max: 3 }),
    }),
    fc.record({ kind: fc.constant("drop" as const) }),
  ),
  { maxLength: 80 },
);

test("snapshot: 止まりの回数と時間、表示キューのあふれは減らない", () => {
  fc.assert(
    fc.property(displayEventsArbitrary, (events) => {
      const stats = new PlaybackTimingStats();
      let nowMs = 0;
      let mediaMicros = 0;
      let previous = stats.snapshot(nowMs);
      for (const event of events) {
        if (event.kind === "display") {
          nowMs += event.elapsedMs;
          mediaMicros += event.frames * 33_333;
          stats.recordDisplay(nowMs, mediaMicros);
        } else {
          stats.recordQueueDrop();
        }
        const current = stats.snapshot(nowMs);
        assert.isAtLeast(current.displayStalls, previous.displayStalls);
        assert.isAtLeast(current.displayStallMs, previous.displayStallMs);
        assert.isAtLeast(current.displayQueueDrops, previous.displayQueueDrops);
        previous = current;
      }
    }),
  );
});

test("recordDisplay: フレーム間隔どおりに表示すると止まりは 0 になる", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1_000, max: 100_000 }),
      fc.integer({ min: 2, max: 300 }),
      (frameMicros, count) => {
        const stats = new PlaybackTimingStats();
        for (let index = 0; index < count; index++) {
          stats.recordDisplay((index * frameMicros) / 1_000, index * frameMicros);
        }
        const snapshot = stats.snapshot(((count - 1) * frameMicros) / 1_000);
        assert.equal(snapshot.displayStalls, 0);
        assert.equal(snapshot.displayStallMs, 0);
      },
    ),
  );
});
