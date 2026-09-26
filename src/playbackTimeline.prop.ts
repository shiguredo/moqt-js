/**
 * PlaybackTimeline の Property-Based Tests
 *
 * 復号の出力の到着列 (観測の順序と経路の揺らぎ) と targetLatency の列を任意に生成し、
 * 表示時刻の式が満たすべき性質を確かめる。
 *
 * - 表示時刻は µs に丸めた TIMESTAMP + 表示の遅れに一致し、表示の遅れから基準の遅れを
 *   引いた追加分は上限 (MAX_PLAYOUT_DELAY_MS とキューが吸収できる長さの小さい方) を超えない
 * - 同じ TIMESTAMP の音声と映像は同じ表示時刻になる (基準も再生遅延も共有する)
 * - 共有の再生遅延は 0 以上で、下げる速さは毎秒 PLAYBACK_DELAY_DECAY_MS_PER_SECOND を
 *   超えない
 * - 120 秒の到着列でも同時刻の音声と映像の表示時刻の差と skewMs は ±50 ms 以内に収まる
 *
 * 個別の規則 (基準の差が閾値を超えたときのフォールバック、音声の下限、切り下げの統計、
 * TIMESTAMP の飛び) は playbackTimeline.test.ts の単体テストが固定する。
 */

import { test, assert } from "vite-plus/test";
import * as fc from "fast-check";
import { JITTER_BUFFER_MAX_QUEUED_FRAMES } from "./playoutBuffer";
import {
  MAX_PLAYOUT_DELAY_MS,
  PLAYBACK_DELAY_DECAY_MS_PER_SECOND,
  PLAYOUT_BASE_MAX_DIFFERENCE_MIN_MS,
  PLAYOUT_QUEUE_HEADROOM_FRAMES,
  PlaybackTimeline,
  type PlaybackStream,
} from "./playbackTimeline";

// 送信側の壁時計 (Unix epoch ミリ秒)。メディア時刻 0 の TIMESTAMP にする
const EPOCH_MS = 1_790_263_445_000;
// 観測の軸 (`performance.now()`) の原点。壁時計 (EPOCH_MS + 経過) から引いた値で観測する。
// 1.79e15 のような大きい値のまま観測すると、倍精度の仮数部が 0.25 ms 刻みになり、経路の
// 遅れ (数十 ms) を表せない
const LOCAL_ORIGIN_MS = 1_000;
// 表示待ちのキューの上限 (枚)。createMediaSubscriber と同じ値にする
const MAX_QUEUED_FRAMES = JITTER_BUFFER_MAX_QUEUED_FRAMES;
// TIMESTAMP (約 1.79e15 マイクロ秒) とミリ秒の変換で生じる誤差を許す幅 (ミリ秒)
const TOLERANCE_MS = 0.01;

/** メディア時刻 (ミリ秒) のフレームの壁時計の時刻 (Unix epoch ミリ秒) */
function epochOf(mediaMs: number): number {
  return EPOCH_MS + mediaMs;
}

/** メディア時刻 (ミリ秒) のフレームの TIMESTAMP (Unix epoch マイクロ秒) */
function timestampOf(mediaMs: number): number {
  return Math.round((EPOCH_MS + mediaMs) * 1_000);
}

/** メディア時刻 (ミリ秒) のフレームを観測する時刻 (`performance.now()` のミリ秒) */
function localOf(mediaMs: number, jitterMs: number): number {
  return LOCAL_ORIGIN_MS + mediaMs + jitterMs;
}

/** 決定論的な擬似乱数 (0 以上 1 未満)。揺らぎの列を任意に作るために使う */
function seededRandom(seed: number): () => number {
  let state = seed % 2_147_483_647;
  if (state <= 0) {
    state += 2_147_483_646;
  }
  return () => {
    state = (state * 16_807) % 2_147_483_647;
    return (state - 1) / 2_147_483_646;
  };
}

/** 観測の列 (到着と targetLatency の設定) の 1 要素 */
type Observation =
  | { readonly kind: "observe"; readonly jitterMs: number }
  | { readonly kind: "targetLatency"; readonly value: number | null };

/**
 * 観測の列を作る
 *
 * 揺らぎは 30 ms 以上 80 ms 以下である。30 ms は経路と復号の最小の遅れ (基準の遅れ) に
 * 相当し、これが無いと表示の遅れが上限 (0 ms) に張り付いて境界を確かめられない。上限を
 * 80 ms にするのは、復号の出力が入力より遅い側へずれ続けないためである (2 つのトラックの
 * 基準の差が閾値を超えたときのフォールバックと TIMESTAMP の飛びは単体テストが固定する)。
 * targetLatency も任意に設定する
 */
function operationsArbitrary() {
  return fc.array(
    fc.oneof(
      {
        weight: 4,
        arbitrary: fc.record({
          kind: fc.constant("observe" as const),
          jitterMs: fc.integer({ min: 30, max: 80 }),
        }),
      },
      {
        weight: 1,
        arbitrary: fc.record({
          kind: fc.constant("targetLatency" as const),
          value: fc.option(fc.integer({ min: 0, max: 3_000 }), { nil: null }),
        }),
      },
    ),
    // キューが吸収できる長さ (フレーム間隔の中央値) が決まる程度の枚数を観測する
    { minLength: 60, maxLength: 300 },
  );
}

/**
 * 観測の列を音声と映像へ与え、観測のたびの結果を記録する
 *
 * 観測の軸は `performance.now()` であり、受信側の壁時計から `LOCAL_ORIGIN_MS` を引いた値に
 * する。どちらのトラックも `frameMs` ごとに進み、復号の出力は「メディア時刻 + 揺らぎ」の
 * 時刻に出るが、前のフレームより早くはならない。2 つのトラックの出力は 1 つの時計の上に
 * あるため、早い方から順に観測する。
 *
 * 最後に targetLatency を設定しただけでも表示の遅れが変わるため、最後は必ず観測にする。
 */
function runObservations(
  operations: readonly Observation[],
  frameMs: number,
): {
  timeline: PlaybackTimeline;
  records: {
    stream: PlaybackStream;
    mediaMs: number;
    wallClockMs: number;
    offsetMs: number;
    presentationDelayMs: number | null;
    playoutDelayMs: number | null;
    presentationWallClockMicros: bigint | null;
  }[];
} {
  const timeline = new PlaybackTimeline({
    timeOriginMs: EPOCH_MS - LOCAL_ORIGIN_MS,
    maxQueuedFrames: MAX_QUEUED_FRAMES,
  });
  const records: {
    stream: PlaybackStream;
    mediaMs: number;
    wallClockMs: number;
    offsetMs: number;
    presentationDelayMs: number | null;
    playoutDelayMs: number | null;
    presentationWallClockMicros: bigint | null;
  }[] = [];
  const pending: { stream: PlaybackStream; mediaMs: number; localMs: number }[] = [];
  const mediaMsOf = { audio: 0, video: 0 };
  const outputLocalMsOf = { audio: LOCAL_ORIGIN_MS, video: LOCAL_ORIGIN_MS };
  const sequence: Observation[] = [...operations, { kind: "observe", jitterMs: 30 }];
  let stream: PlaybackStream = "video";
  for (const operation of sequence) {
    if (operation.kind === "targetLatency") {
      timeline.setTargetLatencyMs(operation.value);
      continue;
    }
    const mediaMs = mediaMsOf[stream] + frameMs;
    // 揺らぎの分だけ遅れて復号の出力へ出るが、前のフレームより早くはならない
    const localMs = Math.max(outputLocalMsOf[stream], localOf(mediaMs, operation.jitterMs));
    mediaMsOf[stream] = mediaMs;
    outputLocalMsOf[stream] = localMs;
    pending.push({ stream, mediaMs, localMs });
    stream = stream === "video" ? "audio" : "video";

    // 2 つのトラックの出力のうち、早い方から観測する (1 つの時計の上にあるため)
    pending.sort((left, right) => left.localMs - right.localMs);
    while (pending.length >= 2) {
      const next = pending.shift();
      if (next === undefined) {
        break;
      }
      const timestampMicros = timestampOf(next.mediaMs);
      timeline.observe(next.stream, epochOf(next.localMs), timestampMicros);
      records.push({
        stream: next.stream,
        mediaMs: next.mediaMs,
        wallClockMs: epochOf(next.localMs),
        // 時間軸が測る「観測の時刻 - メディア時刻」。TIMESTAMP は µs に丸めた値である
        offsetMs: epochOf(next.localMs) - timestampMicros / 1_000,
        presentationDelayMs: timeline.presentationDelayMs,
        playoutDelayMs: timeline.playoutDelayMs,
        presentationWallClockMicros: timeline.presentationWallClockMicros(
          next.stream,
          timestampMicros,
        ),
      });
    }
  }
  // 残りは最後にまとめて観測する (次のフレームが来ないため)
  pending.sort((left, right) => left.localMs - right.localMs);
  for (const next of pending) {
    const timestampMicros = timestampOf(next.mediaMs);
    timeline.observe(next.stream, epochOf(next.localMs), timestampMicros);
    records.push({
      stream: next.stream,
      mediaMs: next.mediaMs,
      wallClockMs: epochOf(next.localMs),
      offsetMs: epochOf(next.localMs) - timestampMicros / 1_000,
      presentationDelayMs: timeline.presentationDelayMs,
      playoutDelayMs: timeline.playoutDelayMs,
      presentationWallClockMicros: timeline.presentationWallClockMicros(
        next.stream,
        timestampMicros,
      ),
    });
  }
  return { timeline, records };
}

test("PlaybackTimeline: 表示時刻は TIMESTAMP + 基準の遅れ + max(targetLatency, 再生遅延) になる", () => {
  fc.assert(
    fc.property(
      operationsArbitrary(),
      fc.double({ min: 8, max: 50, noNaN: true }),
      (operations, frameMs) => {
        const { timeline, records: observations } = runObservations(operations, frameMs);
        // 最後の観測の状態で、表示時刻が式どおりであることを確かめる。時間軸の値は観測の
        // たびに変わるため、最後の観測の直後の値を改めて読む (観測の軸は
        // performance.now() であり、壁時計から原点を引いた値で観測する)
        const last = observations[observations.length - 1];
        if (last === undefined) {
          return;
        }
        const presentationDelayMs = timeline.presentationDelayMs;
        const playoutDelayMs = timeline.playoutDelayMs;
        assert.isNotNull(playoutDelayMs, "最後の観測で再生遅延が決まること");

        // トラックごとの基準の遅れは「観測の時刻 - メディア時刻」の最小値である
        // (観測の軸は performance.now() であり、壁時計から原点を引いた値で観測する)
        const offsetsOf = (target: PlaybackStream): number[] =>
          observations
            .filter((record) => record.stream === target)
            .map((record) => record.offsetMs);
        const audioOffsets = offsetsOf("audio");
        const videoOffsets = offsetsOf("video");
        const bases = [audioOffsets, videoOffsets]
          .filter((offsets) => offsets.length > 0)
          .map((offsets) => Math.min(...offsets));
        const sharedBaseMs = Math.max(...bases);
        // 2 つの基準の差が閾値を超えると基準を共有しない。閾値はキューが吸収できる長さから
        // max(targetLatency, 再生遅延) を引いた値で、下限は
        // PLAYOUT_BASE_MAX_DIFFERENCE_MIN_MS である
        const queueCapMs = Math.min(
          MAX_PLAYOUT_DELAY_MS,
          (MAX_QUEUED_FRAMES - PLAYOUT_QUEUE_HEADROOM_FRAMES) * frameMs,
        );
        const differenceMs =
          audioOffsets.length === 0 || videoOffsets.length === 0
            ? 0
            : Math.abs(Math.min(...audioOffsets) - Math.min(...videoOffsets));
        const sharingBases =
          differenceMs <= Math.max(PLAYOUT_BASE_MAX_DIFFERENCE_MIN_MS, queueCapMs - 500);

        // 表示時刻 = TIMESTAMP + 表示の遅れ。同じ式を時間軸の外でも計算して一致を確かめる
        const wallClockMicros = timeline.presentationWallClockMicros(
          last.stream,
          timestampOf(last.mediaMs),
        );
        if (wallClockMicros === null) {
          // 基準を共有していないときは、基準の差が大きい側だけが表示時刻を返さない
          assert.isFalse(sharingBases, "表示時刻が null なら基準を共有していないこと");
          return;
        }
        assert.isNotNull(presentationDelayMs, "ずれていない側の表示の遅れが決まること");
        const expectedMicros = Math.round(timestampOf(last.mediaMs) + presentationDelayMs * 1_000);
        assert.closeTo(Number(wallClockMicros), expectedMicros, 1);

        // 表示の遅れ - 基準の遅れ = 追加分であり、上限を超えない
        const extraDelayMs = presentationDelayMs - sharedBaseMs;
        assert.isAtLeast(extraDelayMs, 0);
        assert.isAtMost(extraDelayMs, queueCapMs + TOLERANCE_MS);

        // 共有の再生遅延は 0 以上、上限以下
        assert.isAtLeast(playoutDelayMs ?? -1, 0);
        assert.isAtMost(playoutDelayMs ?? Infinity, MAX_PLAYOUT_DELAY_MS + TOLERANCE_MS);

        // 再生遅延が下がった 1 枚では、下げ幅が経過時間 × 毎秒の速さを超えない
        const previous = observations[observations.length - 2];
        if (previous !== undefined && previous.playoutDelayMs !== null) {
          if (playoutDelayMs < previous.playoutDelayMs) {
            const elapsedMs = last.wallClockMs - previous.wallClockMs;
            const allowedMs = (PLAYBACK_DELAY_DECAY_MS_PER_SECOND * elapsedMs) / 1_000;
            // フレーム間隔をマイクロ秒に丸めた差から上限を求めるため、上限の切り替わりでは
            // 1 マイクロ秒 × 枚数だけ動く。その分は許す
            assert.isAtMost(
              previous.playoutDelayMs - playoutDelayMs,
              allowedMs + MAX_QUEUED_FRAMES / 1_000 + TOLERANCE_MS,
            );
          }
        }
      },
    ),
    { numRuns: 50 },
  );
}, 10_000);

test("PlaybackTimeline: 同じ TIMESTAMP の音声と映像は同じ表示時刻になる", () => {
  fc.assert(
    fc.property(
      operationsArbitrary(),
      fc.double({ min: 8, max: 50, noNaN: true }),
      (operations, frameMs) => {
        const { timeline, records } = runObservations(operations, frameMs);
        // 最後の観測の TIMESTAMP を両方のトラックへ与えたときの表示時刻を比べる。基準を
        // 共有していれば一致し、共有していないときはずれた側が null になる
        const last = records[records.length - 1];
        if (last === undefined) {
          return;
        }
        const timestampMicros = timestampOf(last.mediaMs);
        const lastWallClockMicros = timeline.presentationWallClockMicros(
          last.stream,
          timestampMicros,
        );
        const otherStream: PlaybackStream = last.stream === "video" ? "audio" : "video";
        const otherWallClockMicros = timeline.presentationWallClockMicros(
          otherStream,
          timestampMicros,
        );
        if (lastWallClockMicros === null || otherWallClockMicros === null) {
          // 長い停止の後に基準の差が閾値を超えると、ずれた側は表示時刻を返さない
          return;
        }
        assert.equal(
          lastWallClockMicros,
          otherWallClockMicros,
          "同じ TIMESTAMP の表示時刻が一致すること",
        );
      },
    ),
    { numRuns: 50 },
  );
}, 10_000);

/**
 * 120 秒の到着列を作る
 *
 * 音声は 20 ms ごと (Opus)、映像は 30 fps で、どちらも自分のメディア時刻に揺らぎを足した
 * 時刻に復号の出力へ出る。揺らぎは 2% が 40 ms 前後、0.5% が 200 ms 前後で、残りは 30 ms
 * 以内である (p95 が 40 ms 程度になる)
 */
function buildArrivals(seed: number): { stream: PlaybackStream; atMs: number; mediaMs: number }[] {
  const durationMs = 120_000;
  const audioFrameMs = 20;
  const videoFrameMs = 1_000 / 30;
  const audioRandom = seededRandom(seed);
  const videoRandom = seededRandom(seed + 977);
  const jitterOf = (random: () => number): number => {
    const roll = random();
    if (roll > 0.995) {
      return 200 + random() * 40;
    }
    if (roll > 0.975) {
      return 40 + random() * 30;
    }
    return random() * 30;
  };
  const arrivals: { stream: PlaybackStream; atMs: number; mediaMs: number }[] = [];
  for (let index = 0; index * audioFrameMs < durationMs; index++) {
    const mediaMs = index * audioFrameMs;
    arrivals.push({
      stream: "audio",
      atMs: EPOCH_MS + mediaMs + jitterOf(audioRandom),
      mediaMs,
    });
  }
  for (let index = 0; index * videoFrameMs < durationMs; index++) {
    const mediaMs = index * videoFrameMs;
    arrivals.push({
      stream: "video",
      atMs: EPOCH_MS + mediaMs + jitterOf(videoRandom),
      mediaMs,
    });
  }
  arrivals.sort((left, right) => left.atMs - right.atMs);
  return arrivals;
}

test("PlaybackTimeline: 120 秒の到着列でも同時刻の表示時刻の差と skewMs が ±50 ms 以内になる", () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 1_000_000 }), (seed) => {
      const timeline = new PlaybackTimeline({
        timeOriginMs: EPOCH_MS,
        maxQueuedFrames: MAX_QUEUED_FRAMES,
      });
      const durationMs = 120_000;
      const videoFrameMs = 1_000 / 30;
      for (const arrival of buildArrivals(seed)) {
        timeline.observe(arrival.stream, arrival.atMs, timestampOf(arrival.mediaMs));
      }

      // 最後の 10 秒の同時刻の表示時刻の差を見る
      let maxDifferenceMs = 0;
      for (let mediaMs = durationMs - 10_000; mediaMs < durationMs; mediaMs += videoFrameMs) {
        const audioWallClockMicros = timeline.presentationWallClockMicros(
          "audio",
          timestampOf(mediaMs),
        );
        const videoWallClockMicros = timeline.presentationWallClockMicros(
          "video",
          timestampOf(mediaMs),
        );
        assert.isNotNull(audioWallClockMicros, "音声の表示時刻が決まること");
        assert.isNotNull(videoWallClockMicros, "映像の表示時刻が決まること");
        maxDifferenceMs = Math.max(
          maxDifferenceMs,
          Math.abs(Number(audioWallClockMicros) - Number(videoWallClockMicros)) / 1_000,
        );
      }
      assert.isAtMost(maxDifferenceMs, 50, "同時刻の表示時刻の差が 50 ms 以内であること");

      // 実績から求める同期ずれも、同じ式で決めた音声と映像なら ±50 ms 以内になる
      const timestampMicros = timestampOf(durationMs - 1_000);
      const audioWallClockMicros = timeline.presentationWallClockMicros("audio", timestampMicros);
      const videoWallClockMicros = timeline.presentationWallClockMicros("video", timestampMicros);
      assert.isNotNull(audioWallClockMicros);
      assert.isNotNull(videoWallClockMicros);
      timeline.recordPresentation("audio", timestampMicros, audioWallClockMicros ?? 0n);
      timeline.recordPresentation("video", timestampMicros, videoWallClockMicros ?? 0n);
      const skewMs = timeline.skewMs();
      assert.isNotNull(skewMs, "同期ずれが求まること");
      assert.isAtMost(Math.abs(skewMs ?? Infinity), 50, "同期ずれが 50 ms 以内であること");
    }),
    // CI の runner はローカルより遅いため、120 秒の列を作る回数を抑える (1 回で 30 fps と
    // Opus の 120 秒分の観測を回す)
    { numRuns: 5 },
  );
}, 30_000);
