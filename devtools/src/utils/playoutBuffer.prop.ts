/**
 * PlayoutBuffer の Property-Based Tests
 *
 * 揺らぎのあるフレームの到着と requestAnimationFrame 相当の選択を任意の時刻の列として
 * 生成し、jitter buffer が満たすべき性質を確かめる。
 *
 * - フレームを並べ替えない (描く・捨てる順は積んだ順であり、各フレームは 1 回だけ出る)
 * - 表示時刻より前に描かない
 * - 積んだフレームは再生遅延より長く待たない
 * - 再生遅延は 0 以上、上限以下であり、下げる速さは上限を超えない
 * - 揺らぎの p95 が最大の揺らぎと一致する到着列では、表示間隔が TIMESTAMP の間隔どおりになる
 *
 * 個別の規則 (最新を残して 1 つ前を描き、古いものを捨てる、TIMESTAMP の飛び、キューの上限) は
 * playoutBuffer.test.ts の単体テストが固定する。
 */

import { test, assert } from "vite-plus/test";
import * as fc from "fast-check";
import {
  JITTER_BUFFER_MAX_QUEUED_FRAMES,
  MAX_PLAYOUT_DELAY_MS,
  PLAYOUT_DELAY_DECAY_MS_PER_SECOND,
  PLAYOUT_WINDOW_MS,
  PlayoutBuffer,
} from "./playoutBuffer";

// 送信側の壁時計 (Unix epoch ミリ秒)。メディア時刻 0 のフレームの TIMESTAMP にする
const EPOCH_MS = 1_790_263_445_000;
// 受信側でメディア時刻 0 のフレームが揺らぎ無しで表示できるようになる時刻
const LOCAL_ORIGIN_MS = 1_000;
// TIMESTAMP (約 1.79e15 マイクロ秒) をミリ秒にしたときの浮動小数点の誤差を許す幅 (ミリ秒)
const TOLERANCE_MS = 0.01;

/** メディア時刻 (ミリ秒) のフレームの TIMESTAMP (Unix epoch マイクロ秒) */
function timestampOf(mediaMs: number): number {
  return Math.round((EPOCH_MS + mediaMs) * 1_000);
}

/**
 * 操作の列。フレームを積む (揺らぎ、壁時計の TIMESTAMP の有無) か、経過の後に選択する。
 * 揺らぎは TIMESTAMP の飛びとみなす 2 秒より小さくする (基準の取り直しを起こさない)
 */
function operationsArbitrary(withoutTimestamp: boolean) {
  return fc.array(
    fc.oneof(
      fc.record({
        kind: fc.constant("enqueue" as const),
        wallClock: withoutTimestamp ? fc.boolean() : fc.constant(true),
        jitterMs: fc.integer({ min: 0, max: 1_000 }),
      }),
      fc.record({
        kind: fc.constant("select" as const),
        elapsedMs: fc.integer({ min: 0, max: 200 }),
      }),
    ),
    { maxLength: 200 },
  );
}

test("PlayoutBuffer: 描く・捨てる順は積んだ順であり、各フレームは 1 回だけ出る", () => {
  fc.assert(
    fc.property(
      operationsArbitrary(true),
      fc.double({ min: 8, max: 50, noNaN: true }),
      fc.integer({ min: 1, max: JITTER_BUFFER_MAX_QUEUED_FRAMES }),
      (operations, frameMs, maxQueuedFrames) => {
        const buffer = new PlayoutBuffer<number>(maxQueuedFrames);
        const removed: number[] = [];
        let enqueued = 0;
        let nowMs = LOCAL_ORIGIN_MS;
        for (const operation of operations) {
          if (operation.kind === "enqueue") {
            // 復号は順に行うため、表示できるようになる時刻は前のフレームより早くならない
            const mediaMs = enqueued * frameMs;
            nowMs = Math.max(nowMs, LOCAL_ORIGIN_MS + mediaMs + operation.jitterMs);
            removed.push(
              ...buffer.enqueue(enqueued, nowMs, operation.wallClock ? timestampOf(mediaMs) : null),
            );
            enqueued++;
            assert.isAtMost(buffer.size, maxQueuedFrames);
          } else {
            nowMs += operation.elapsedMs;
            const selection = buffer.select(nowMs);
            removed.push(...selection.late);
            if (selection.draw !== null) {
              removed.push(selection.draw);
            }
          }
        }
        removed.push(...buffer.clear());
        assert.deepEqual(
          removed,
          Array.from({ length: enqueued }, (_, index) => index),
        );
      },
    ),
  );
});

test("PlayoutBuffer: 表示時刻より前に描かず、再生遅延の範囲と下げる速さを守る", () => {
  fc.assert(
    fc.property(
      operationsArbitrary(false),
      fc.double({ min: 8, max: 50, noNaN: true }),
      (operations, frameMs) => {
        const buffer = new PlayoutBuffer<number>(JITTER_BUFFER_MAX_QUEUED_FRAMES);
        let enqueued = 0;
        let nowMs = LOCAL_ORIGIN_MS;
        let previousDelay: { atMs: number; delayMs: number } | null = null;
        for (const operation of operations) {
          if (operation.kind === "enqueue") {
            const mediaMs = enqueued * frameMs;
            nowMs = Math.max(nowMs, LOCAL_ORIGIN_MS + mediaMs + operation.jitterMs);
            buffer.enqueue(enqueued, nowMs, timestampOf(mediaMs));
            enqueued++;

            const delayMs = buffer.playoutDelayMs();
            assert.isNotNull(delayMs);
            const delay = delayMs ?? 0;
            assert.isAtLeast(delay, 0);
            assert.isAtMost(delay, MAX_PLAYOUT_DELAY_MS);
            // 積んだフレームは再生遅延より長く待たない
            const presentationMs = buffer.presentationTimeMs(timestampOf(mediaMs));
            assert.isAtMost((presentationMs ?? Infinity) - nowMs, delay + TOLERANCE_MS);
            // 下げる速さは毎秒 PLAYOUT_DELAY_DECAY_MS_PER_SECOND まで。
            // 再生遅延の上限 (キューの枚数分のフレーム間隔) は TIMESTAMP をマイクロ秒に
            // 丸めた差から求めるため、フレーム間隔が 1 マイクロ秒動くと上限が
            // (キューの上限 - 余裕) マイクロ秒動く。その分は許す
            if (previousDelay !== null && delay < previousDelay.delayMs) {
              const allowedMs =
                (PLAYOUT_DELAY_DECAY_MS_PER_SECOND * (nowMs - previousDelay.atMs)) / 1_000;
              // 1 マイクロ秒 × 枚数をミリ秒にする
              const roundingMs = JITTER_BUFFER_MAX_QUEUED_FRAMES / 1_000;
              assert.isAtMost(previousDelay.delayMs - delay, allowedMs + roundingMs + TOLERANCE_MS);
            }
            previousDelay = { atMs: nowMs, delayMs: delay };
          } else {
            nowMs += operation.elapsedMs;
            const selection = buffer.select(nowMs);
            // 描いたフレームは表示時刻を過ぎている (選択は基準と再生遅延を変えない)
            if (selection.draw !== null) {
              const presentationMs = buffer.presentationTimeMs(
                timestampOf(selection.draw * frameMs),
              );
              assert.isAtMost(presentationMs ?? Infinity, nowMs + TOLERANCE_MS);
            }
          }
        }
      },
    ),
  );
});

/**
 * 揺らぎの型。L 枚ごとに繰り返す列で、先頭の 2 枚は揺らぎ無し、各周期の 1 割以上は最大の
 * 揺らぎ J である。窓の中の揺らぎの p95 は J になり、再生遅延は J で安定する
 */
const jitterPatternArbitrary = fc
  .record({
    length: fc.integer({ min: 3, max: 20 }),
    jitterMs: fc.integer({ min: 1, max: 150 }),
    seed: fc.array(fc.boolean(), { minLength: 20, maxLength: 20 }),
  })
  .map(({ length, jitterMs, seed }) => {
    const late = seed.slice(0, length).map((value, index) => index >= 2 && value);
    // 周期の 1 割以上を最大の揺らぎにする (先頭の 2 枚を除く末尾から埋める)
    const required = Math.ceil(length * 0.1);
    for (let index = length - 1; late.filter(Boolean).length < required; index--) {
      late[index] = true;
    }
    return { pattern: late.map((value) => (value ? jitterMs : 0)), jitterMs };
  });

test("PlayoutBuffer: 揺らぎの p95 が最大の揺らぎのとき、表示間隔は TIMESTAMP の間隔どおりになる", () => {
  fc.assert(
    fc.property(
      jitterPatternArbitrary,
      fc.double({ min: 20, max: 50, noNaN: true }),
      ({ pattern, jitterMs }, frameMs) => {
        const buffer = new PlayoutBuffer<number>(JITTER_BUFFER_MAX_QUEUED_FRAMES);
        // 窓 (10 秒) の中で基準 (揺らぎ無しのフレーム) が入れ替わらない長さだけ測る
        const endMs = PLAYOUT_WINDOW_MS - 1_000;
        const frames = Math.floor(endMs / frameMs);
        const arrivals: number[] = [];
        let available = 0;
        for (let index = 0; index < frames; index++) {
          available = Math.max(
            available,
            LOCAL_ORIGIN_MS + index * frameMs + (pattern[index % pattern.length] ?? 0),
          );
          arrivals.push(available);
        }
        // 1 ms ごとに選択する (requestAnimationFrame の代わり)。刻みの誤差は 1 ms まで
        const draws: { atMs: number; index: number }[] = [];
        const late: number[] = [];
        let next = 0;
        for (let nowMs = LOCAL_ORIGIN_MS; nowMs < LOCAL_ORIGIN_MS + endMs + 500; nowMs++) {
          while (next < arrivals.length && (arrivals[next] ?? Infinity) <= nowMs) {
            buffer.enqueue(next, arrivals[next] ?? nowMs, timestampOf(next * frameMs));
            next++;
          }
          const selection = buffer.select(nowMs);
          late.push(...selection.late);
          if (selection.draw !== null) {
            draws.push({ atMs: nowMs, index: selection.draw });
          }
        }
        // 最初の 2 秒 (揺らぎを覚えるまで) を除く
        const warmupFrames = Math.ceil(2_000 / frameMs);
        const steady = draws.filter((draw) => draw.index >= warmupFrames);
        for (let position = 1; position < steady.length; position++) {
          const previous = steady[position - 1];
          const current = steady[position];
          assert.equal((current?.index ?? 0) - (previous?.index ?? 0), 1);
          const intervalMs = (current?.atMs ?? 0) - (previous?.atMs ?? 0);
          assert.isAtLeast(intervalMs, frameMs - 1 - TOLERANCE_MS);
          assert.isAtMost(intervalMs, frameMs + 1 + TOLERANCE_MS);
        }
        assert.deepEqual(
          late.filter((index) => index >= warmupFrames),
          [],
        );
        assert.closeTo(buffer.playoutDelayMs() ?? 0, jitterMs, TOLERANCE_MS);
      },
    ),
    { numRuns: 50 },
  );
});
