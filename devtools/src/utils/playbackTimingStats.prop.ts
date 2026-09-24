/**
 * PlaybackTimingStats の Property-Based Tests
 *
 * 到着・復号・表示の記録を任意の時刻の列として生成し、統計が満たすべき性質を確かめる。
 *
 * - 分布は窓の中の値だけから求める (実装と独立したモデルと比べる)
 * - 到着の揺らぎは送信側と受信側の時計のずれに依らない
 * - 累積の値 (止まりの回数と時間、表示キューのあふれ) は減らない
 * - 表示間隔がフレーム間隔どおりなら止まりは 0 である
 * - 止まりごとに原因を 1 つ決め、原因ごとの回数と時間の和は止まりの回数と時間に一致する
 *
 * 境界値 (百分位の定義、復号時間の対応づけ、リセット) は playbackTimingStats.test.ts の
 * 単体テストが固定する。
 */

import { test, assert } from "vite-plus/test";
import * as fc from "fast-check";
import {
  MAX_RECENT_STALLS,
  PLAYBACK_TIMING_WINDOW_MS,
  PlaybackTimingStats,
  type TimingSummary,
} from "./playbackTimingStats";
import { STALL_CAUSES } from "./stallAnalysis";

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
          stats.recordQueueDrop(mediaMicros);
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

/** 1 / outOf の確率で true になる */
function chance(outOf: number): fc.Arbitrary<boolean> {
  return fc.integer({ min: 0, max: outOf - 1 }).map((value) => value === 0);
}

/**
 * 1 フレームの受け取りから表示までの行方
 *
 * フレームはメディア時刻 (40 ms 間隔) の順に並べ、Group は groupSize 枚ごとに切り替える。
 * 時刻はメディア時刻からの遅れとして生成し、記録は時刻の順に行う
 */
const frameFateArbitrary = fc.record({
  // 受け取らない (経路で失われた)
  lost: chance(10),
  // 受け取りの遅れ (ミリ秒)。まれに大きく遅れる
  receiveDelayMs: fc.oneof(
    { weight: 4, arbitrary: fc.integer({ min: 0, max: 30 }) },
    { weight: 1, arbitrary: fc.integer({ min: 30, max: 400 }) },
  ),
  // Group の切り替えの保留 (ミリ秒)
  holdMs: fc.oneof(
    { weight: 4, arbitrary: fc.constant(0) },
    { weight: 1, arbitrary: fc.integer({ min: 1, max: 60 }) },
  ),
  // 復号せずに捨てる
  discarded: chance(10),
  decodeMs: fc.oneof(
    { weight: 4, arbitrary: fc.integer({ min: 1, max: 5 }) },
    { weight: 1, arbitrary: fc.integer({ min: 5, max: 200 }) },
  ),
  // 表示できる状態になってから描くまで (ミリ秒)。まれに描画が大きく遅れる
  renderDelayMs: fc.oneof(
    { weight: 4, arbitrary: fc.integer({ min: 0, max: 17 }) },
    { weight: 1, arbitrary: fc.integer({ min: 17, max: 300 }) },
  ),
  // 表示せずに捨てる (表示キューのあふれ / jitter buffer が間に合わずに捨てる)
  dropped: fc.constantFrom(null, null, null, "queue" as const, "late" as const),
  // jitter buffer の表示時刻 (受け取りの遅れの基準からのずれ、ミリ秒)。null は jitter buffer 無し
  presentationOffsetMs: fc.option(fc.integer({ min: 0, max: 200 }), { nil: null }),
  // Group の最後のフレームの後に、stream を RESET_STREAM で終える
  resetAtGroupEnd: chance(5),
  // TIMESTAMP を飛ばす (publisher がフレームを撮れていない) フレーム数
  sourceSkip: fc.oneof(
    { weight: 9, arbitrary: fc.constant(0) },
    { weight: 1, arbitrary: fc.integer({ min: 1, max: 5 }) },
  ),
});

/** 記録の操作。時刻の順に並べてから記録する */
interface TimelineOperation {
  atMs: number;
  order: number;
  apply: (stats: PlaybackTimingStats) => void;
}

// 実際に近い時系列 (受け取り、保留、復号、表示の時刻と、Object と Group の欠け、stream の
// reset、TIMESTAMP の飛び) で、止まりの原因が必ず 1 つに決まり、原因ごとの回数と時間の和が
// 止まりの回数と時間に一致する
test("recordDisplay: 実際に近い時系列でも、原因ごとの止まりの和は止まりの回数と時間に一致する", () => {
  fc.assert(
    fc.property(
      fc.array(frameFateArbitrary, { minLength: 3, maxLength: 60 }),
      fc.integer({ min: 1, max: 30 }),
      (fates, groupSize) => {
        const frameMs = 40;
        const operations: TimelineOperation[] = [];
        const add = (atMs: number, apply: (stats: PlaybackTimingStats) => void): void => {
          operations.push({ atMs, order: operations.length, apply });
        };
        let mediaIndex = 0;
        // 保留は届いた順に解け (処理は到着順の Promise チェーン)、decoder は渡した順に出力し、
        // 表示キューは TIMESTAMP の順に取り出す (描くか捨てる)。それぞれの時刻は前の
        // フレームより前にならない
        let lastReleasedMs = 0;
        let lastDecodedMs = 0;
        let lastDequeuedMs = 0;
        fates.forEach((fate, index) => {
          mediaIndex += 1 + fate.sourceSkip;
          const mediaMs = mediaIndex * frameMs;
          const timestampMicros = mediaMs * 1_000;
          const groupId = BigInt(Math.floor(index / groupSize));
          const objectId = BigInt(index % groupSize);
          const isGroupEnd = index % groupSize === groupSize - 1 || index === fates.length - 1;
          const receivedAtMs = mediaMs + fate.receiveDelayMs;
          if (isGroupEnd) {
            // Group の stream の終わりは、最後の Object の受け取りの直後に通知される
            add(receivedAtMs, (stats) => {
              stats.recordSubgroupEnd(groupId, 0n, fate.resetAtGroupEnd ? "reset" : "fin");
            });
          }
          if (fate.lost) {
            return;
          }
          add(receivedAtMs, (stats) => {
            stats.recordObjectReceived(
              { groupId, objectId, priorObjectIdGap: 0n },
              0n,
              timestampMicros,
              receivedAtMs,
            );
          });
          const releasedAtMs = Math.max(lastReleasedMs, receivedAtMs + fate.holdMs);
          lastReleasedMs = releasedAtMs;
          add(releasedAtMs, (stats) => {
            stats.recordObjectReleased(timestampMicros, releasedAtMs);
            if (fate.discarded) {
              stats.recordDiscarded(timestampMicros);
            } else {
              stats.recordDecodeStart(releasedAtMs, timestampMicros);
            }
          });
          if (fate.discarded) {
            return;
          }
          const decodedAtMs = Math.max(lastDecodedMs, releasedAtMs + fate.decodeMs);
          lastDecodedMs = decodedAtMs;
          add(decodedAtMs, (stats) => {
            stats.recordDecodeOutput(decodedAtMs, timestampMicros);
          });
          const presentationMs =
            fate.presentationOffsetMs === null ? null : mediaMs + 20 + fate.presentationOffsetMs;
          const displayMs = Math.max(
            lastDequeuedMs,
            decodedAtMs + fate.renderDelayMs,
            presentationMs ?? 0,
          );
          lastDequeuedMs = displayMs;
          if (fate.dropped === "queue") {
            add(displayMs, (stats) => {
              stats.recordQueueDrop(timestampMicros);
            });
            return;
          }
          if (fate.dropped === "late") {
            add(displayMs, (stats) => {
              stats.recordLateDrop(timestampMicros, presentationMs ?? displayMs);
            });
            return;
          }
          add(displayMs, (stats) => {
            stats.recordDisplay(displayMs, timestampMicros, presentationMs);
          });
        });
        operations.sort((a, b) => a.atMs - b.atMs || a.order - b.order);

        const stats = new PlaybackTimingStats();
        for (const operation of operations) {
          operation.apply(stats);
        }
        const endMs = operations.at(-1)?.atMs ?? 0;
        const snapshot = stats.snapshot(endMs);
        let count = 0;
        let ms = 0;
        for (const cause of STALL_CAUSES) {
          count += snapshot.stallCauses[cause].count;
          ms += snapshot.stallCauses[cause].ms;
        }
        assert.equal(count, snapshot.displayStalls, "原因ごとの回数の和");
        assert.closeTo(ms, snapshot.displayStallMs, 1e-6, "原因ごとの時間の和");
        assert.equal(
          snapshot.recentStalls.length,
          Math.min(snapshot.displayStalls, MAX_RECENT_STALLS),
          "直近の止まりの数",
        );
        // すべてのフレームを記録してから表示しているため、原因を決められない止まりは無い
        assert.equal(snapshot.stallCauses.unknown.count, 0, "unknown の止まり");
        assert.isAtLeast(snapshot.missingObjects, 0);
        assert.isAtLeast(snapshot.missingGroups, 0);
      },
    ),
    // 止まりが起きる時系列は 1 割程度のため、回数を増やしてすべての原因を通す
    { numRuns: 1_000 },
  );
});
