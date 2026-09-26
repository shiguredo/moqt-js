/**
 * PlayoutBuffer の Property-Based Tests
 *
 * 揺らぎのあるフレームの到着 (復号の出力) と requestAnimationFrame 相当の選択を任意の時刻の
 * 列として生成し、共有の時間軸 (PlaybackTimeline) が決めた表示時刻で選ぶキューが満たすべき
 * 性質を確かめる。
 *
 * - フレームを並べ替えない (描く・捨てる順は積んだ順であり、各フレームは 1 回だけ出る)
 * - 壁時計の TIMESTAMP を持つフレームは表示時刻より前に描かない
 * - 再生遅延は 0 以上、キューが吸収できる長さ以下であり、下げる速さは上限を超えない
 * - 揺らぎの p95 が最大の揺らぎと一致する到着列では、表示間隔が TIMESTAMP の間隔どおりになる
 *
 * 個別の規則 (最新を残して 1 つ前を描き、古いものを捨てる、TIMESTAMP の飛び、キューの上限、
 * TIMESTAMP を持たないフレームの到着順の再生) は playoutBuffer.test.ts の単体テストが固定する。
 */

import { test, assert } from "vite-plus/test";
import * as fc from "fast-check";
import { JITTER_BUFFER_MAX_QUEUED_FRAMES, PlayoutBuffer } from "./playoutBuffer";
import {
  MAX_PLAYOUT_DELAY_MS,
  PLAYBACK_DELAY_DECAY_MS_PER_SECOND,
  PLAYBACK_WINDOW_MS,
  PLAYOUT_QUEUE_HEADROOM_FRAMES,
  PlaybackTimeline,
} from "./playbackTimeline";

// 送信側の壁時計 (Unix epoch ミリ秒)。メディア時刻 0 のフレームの TIMESTAMP にする
const EPOCH_MS = 1_790_263_445_000;
// 受信側の観測の軸 (`performance.now()`) の原点。メディア時刻 0 のフレームが揺らぎ無しで
// 復号の出力へ出る時刻
const LOCAL_ORIGIN_MS = 1_000;
// TIMESTAMP (約 1.79e15 マイクロ秒) とミリ秒の変換で生じる誤差を許す幅 (ミリ秒)
const TOLERANCE_MS = 0.01;

/** メディア時刻 (ミリ秒) のフレームの TIMESTAMP (Unix epoch マイクロ秒) */
function timestampOf(mediaMs: number): number {
  return Math.round((EPOCH_MS + mediaMs) * 1_000);
}

/** 表示時刻を決める時間軸を作る (原点は `EPOCH_MS`、表示時刻は `performance.now()` の軸) */
function createTimeline(): PlaybackTimeline {
  return new PlaybackTimeline({
    timeOriginMs: EPOCH_MS,
    maxQueuedFrames: JITTER_BUFFER_MAX_QUEUED_FRAMES,
    audioDelayFloorMs: 0,
  });
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
        const timeline = createTimeline();
        const buffer = new PlayoutBuffer<number>(maxQueuedFrames, timeline);
        const removed: number[] = [];
        let enqueued = 0;
        // 復号の出力の時刻 (performance.now() の軸)。前のフレームより早くはならない
        let localMs = LOCAL_ORIGIN_MS;
        for (const operation of operations) {
          if (operation.kind === "enqueue") {
            const mediaMs = enqueued * frameMs;
            localMs = Math.max(localMs + frameMs, LOCAL_ORIGIN_MS + mediaMs + operation.jitterMs);
            if (operation.wallClock) {
              timeline.observe("video", EPOCH_MS + localMs, timestampOf(mediaMs));
              removed.push(...buffer.enqueue(enqueued, timestampOf(mediaMs)));
            } else {
              removed.push(...buffer.enqueue(enqueued, null));
            }
            enqueued++;
            assert.isAtMost(buffer.size, maxQueuedFrames);
          } else {
            localMs += operation.elapsedMs;
            const selection = buffer.select(localMs);
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
        const timeline = createTimeline();
        const buffer = new PlayoutBuffer<number>(JITTER_BUFFER_MAX_QUEUED_FRAMES, timeline);
        let enqueued = 0;
        let localMs = LOCAL_ORIGIN_MS;
        let previousDelay: { atMs: number; delayMs: number } | null = null;
        for (const operation of operations) {
          if (operation.kind === "enqueue") {
            const mediaMs = enqueued * frameMs;
            localMs = Math.max(localMs + frameMs, LOCAL_ORIGIN_MS + mediaMs + operation.jitterMs);
            timeline.observe("video", EPOCH_MS + localMs, timestampOf(mediaMs));
            buffer.enqueue(enqueued, timestampOf(mediaMs));
            enqueued++;

            const delayMs = buffer.playoutDelayMs();
            assert.isNotNull(delayMs);
            const delay = delayMs ?? 0;
            assert.isAtLeast(delay, 0);
            assert.isAtMost(delay, MAX_PLAYOUT_DELAY_MS);
            // 積んだフレームの表示時刻は「メディア時刻 + 表示の遅れ」である
            const presentationMs = buffer.presentationTimeMs(timestampOf(mediaMs));
            // 表示時刻は「メディア時刻 + 基準の遅れ + 再生遅延」である。再生遅延は上限
            // (MAX_PLAYOUT_DELAY_MS) を超えず、基準の遅れは `LOCAL_ORIGIN_MS` に揺らぎと
            // 上限 (キューが吸収できる長さ) を足した値になる
            assert.isAtMost(presentationMs ?? Infinity, localMs + MAX_PLAYOUT_DELAY_MS + 0.1);
            // 下げる速さは毎秒 PLAYBACK_DELAY_DECAY_MS_PER_SECOND まで。
            // 再生遅延の上限 (キューの枚数分のフレーム間隔) は TIMESTAMP をマイクロ秒に
            // 丸めた差から求めるため、フレーム間隔が 1 マイクロ秒動くと上限が
            // (キューの上限 - 余裕) マイクロ秒動く。その分は許す
            if (previousDelay !== null && delay < previousDelay.delayMs) {
              const allowedMs =
                (PLAYBACK_DELAY_DECAY_MS_PER_SECOND * (localMs - previousDelay.atMs)) / 1_000;
              const roundingMs = JITTER_BUFFER_MAX_QUEUED_FRAMES / 1_000;
              assert.isAtMost(previousDelay.delayMs - delay, allowedMs + roundingMs + TOLERANCE_MS);
            }
            previousDelay = { atMs: localMs, delayMs: delay };
          } else {
            localMs += operation.elapsedMs;
            const selection = buffer.select(localMs);
            // 描いたフレームは表示時刻を過ぎている (選択は時間軸を変えない)
            if (selection.draw !== null) {
              const presentationMs = buffer.presentationTimeMs(
                timestampOf(selection.draw * frameMs),
              );
              // 表示時刻 (performance.now() の軸) を過ぎたフレームだけを描く
              assert.isAtMost(presentationMs ?? Infinity, localMs + 0.1);
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
    // 1 ms 刻みでは p95 が 0 に丸められるため、経路の揺らぎとして意味のある大きさにする
    jitterMs: fc.integer({ min: 5, max: 150 }),
    seed: fc.array(fc.boolean(), { minLength: 20, maxLength: 20 }),
  })
  .map(({ length, jitterMs, seed }) => {
    const late = seed.slice(0, length).map((value, index) => index >= 2 && value);
    // 周期の 1 割以上を最大の揺らぎにする (窓の中で p95 が最大になる枚数。先頭の 2 枚を
    // 除く末尾から埋める)
    const required = Math.max(2, Math.ceil(length * 0.1));
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
        const timeline = createTimeline();
        const buffer = new PlayoutBuffer<number>(JITTER_BUFFER_MAX_QUEUED_FRAMES, timeline);
        // 窓 (10 秒) の中で基準 (揺らぎ無しのフレーム) が入れ替わらない長さだけ測る
        const endMs = PLAYBACK_WINDOW_MS - 1_000;
        const frames = Math.floor(endMs / frameMs);
        // 復号の出力は「メディア時刻 + 揺らぎ」の時刻に出る。揺らぎは到着を後ろへずらす
        // だけであり、表示間隔は TIMESTAMP の間隔のままになる
        const arrivals: number[] = [];
        for (let index = 0; index < frames; index++) {
          arrivals.push(LOCAL_ORIGIN_MS + index * frameMs + (pattern[index % pattern.length] ?? 0));
        }
        // 1 ms ごとに選択する (requestAnimationFrame の代わり)。刻みの誤差は 1 ms まで
        const draws: { localMs: number; index: number }[] = [];
        const late: number[] = [];
        let next = 0;
        for (let nowMs = LOCAL_ORIGIN_MS; nowMs < LOCAL_ORIGIN_MS + endMs + 500; nowMs++) {
          while (next < arrivals.length && (arrivals[next] ?? Infinity) <= nowMs) {
            const mediaMs = next * frameMs;
            // 観測の時刻は到着の時刻そのものである。観測の間隔が復号の出力の間隔になる
            timeline.observe("video", EPOCH_MS + (arrivals[next] ?? nowMs), timestampOf(mediaMs));
            buffer.enqueue(next, timestampOf(mediaMs));
            next++;
          }
          const selection = buffer.select(nowMs);
          late.push(...selection.late);
          if (selection.draw !== null) {
            draws.push({ localMs: nowMs, index: selection.draw });
          }
        }
        // 最初の 2 秒 (揺らぎを覚えるまで) を除く
        const warmupFrames = Math.ceil(2_000 / frameMs);
        const steady = draws.filter((draw) => draw.index >= warmupFrames);
        for (let position = 1; position < steady.length; position++) {
          const previous = steady[position - 1];
          const current = steady[position];
          assert.equal((current?.index ?? 0) - (previous?.index ?? 0), 1);
          const intervalMs = (current?.localMs ?? 0) - (previous?.localMs ?? 0);
          assert.isAtLeast(intervalMs, frameMs - 1 - TOLERANCE_MS);
          assert.isAtMost(intervalMs, frameMs + 1 + TOLERANCE_MS);
        }
        assert.deepEqual(
          late.filter((index) => index >= warmupFrames),
          [],
        );
        // 揺らぎは µs に丸めた TIMESTAMP の差から求めるため、1 ms の丸めを許す
        assert.closeTo(buffer.playoutDelayMs() ?? 0, jitterMs, 1);
      },
    ),
    { numRuns: 50 },
  );
});

// キューが吸収できる長さ (上限 - 余裕) を超える揺らぎは再生遅延に使わない (上限で抑える)
test("PlayoutBuffer: 再生遅延はキューが吸収できる長さを超えない", () => {
  fc.assert(
    fc.property(
      fc.double({ min: 8, max: 50, noNaN: true }),
      fc.integer({ min: 100, max: 5_000 }),
      (frameMs, jitterMs) => {
        const timeline = createTimeline();
        const buffer = new PlayoutBuffer<number>(JITTER_BUFFER_MAX_QUEUED_FRAMES, timeline);
        let localMs = LOCAL_ORIGIN_MS;
        for (let index = 0; index < 500; index++) {
          const mediaMs = index * frameMs;
          localMs = Math.max(localMs + frameMs, LOCAL_ORIGIN_MS + mediaMs + jitterMs);
          timeline.observe("video", EPOCH_MS + localMs, timestampOf(mediaMs));
          buffer.clear();
        }
        // キューが吸収できる長さは (上限 - 余裕) 枚分のフレーム間隔である。TIMESTAMP を
        // マイクロ秒に丸めた差から求めるため、丸めの誤差 (1 マイクロ秒 × 枚数) を許す
        const queueCapMs =
          (JITTER_BUFFER_MAX_QUEUED_FRAMES - PLAYOUT_QUEUE_HEADROOM_FRAMES) * frameMs;
        assert.isAtMost(
          buffer.playoutDelayMs() ?? Infinity,
          Math.min(MAX_PLAYOUT_DELAY_MS, queueCapMs) + JITTER_BUFFER_MAX_QUEUED_FRAMES / 1_000,
        );
      },
    ),
    { numRuns: 50 },
  );
});
