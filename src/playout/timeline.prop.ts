/**
 * PlayoutTimeline の Property-Based Tests
 *
 * 復号の出力の到着列 (観測の順序と経路の揺らぎ) と targetLatency の列を任意に生成し、
 * 表示時刻の式が満たすべき性質を確かめる。
 *
 * - 表示時刻は µs に丸めた TIMESTAMP + 表示の遅れに一致し、表示の遅れから基準の遅れを
 *   引いた追加分は上限 (MAX_PLAYOUT_DELAY_MS とキューが吸収できる長さの小さい方) を超えない
 * - 同じ TIMESTAMP の音声と映像の表示時刻は、不感帯 (SYNC_MIN_DELTA_MS) の範囲で揃う
 * - 共有の再生遅延は 0 以上で、キューの上限を超えない
 * - 基準の差を補償する量は PLAYOUT_MAX_COMPENSATED_DIFFERENCE_MS までとし、同じ向きの
 *   既知のバッファ差は別に補償する。時計のずれの証拠を見る前でも基準の保護を掛ける。
 *   過去に差が開いた 120 秒の到着列でも、補償できない分を超えてずれを広げない
 *
 * 個別の規則 (基準の差が閾値を超えたときのフォールバック、基準の差の動き (時計のずれ)、
 * やめた判定の保持、音声の下限、切り下げの統計、TIMESTAMP の飛び) は
 * src/playout/timeline.test.ts の単体テストが固定する。property テストは、テストが独立に
 * 計算できる量 (差の大きさ) だけを突き合わせる。
 */

import { test, assert } from "vite-plus/test";
import * as fc from "fast-check";

// setter の直後にも計器と実際に使う目標が一致する。次の音声観測で直るだけでは、
// 一時停止中に上限を変更する利用者には古い値が残る。

// 共通の cache 遅延が減った分を同期の待ち時間へ移してはならない。両側の観測順も変え、
// 片側ずつ更新される実際の入口で、追いつき後に通常の深さへ戻ることを確かめる。
test("PlayoutTimeline: 共通の基準遅延を解消したら待ち時間へ持ち越さない", () => {
  fc.assert(
    fc.property(fc.integer({ min: 5, max: 100 }), fc.boolean(), (frames, audioFirst) => {
      const timeline = new PlayoutTimeline({ timeOriginMs: 0, maxQueuedFrames: 24 });
      const observe = (atMs: number, mediaMs: number): void => {
        const streams: PlayoutStream[] = audioFirst ? ["audio", "video"] : ["video", "audio"];
        for (const stream of streams) timeline.observe(stream, atMs, mediaMs * 1_000);
      };
      for (let index = 0; index <= frames; index++) observe(frames * 10 + index * 10, index * 20);
      for (let elapsed = 20; elapsed <= 2_000; elapsed += 20) {
        const atMs = frames * 20 + elapsed;
        observe(atMs, atMs);
      }
      const delays = timeline.delayBreakdown;
      assert.equal(delays.audio.baseDelayMs, 0);
      assert.equal(delays.video.baseDelayMs, 0);
      assert.isAtMost(
        delays.audio.presentationDelayMs ?? Infinity,
        80.01,
        "過去の基準遅延を残さないこと",
      );
      assert.isAtMost(
        delays.video.presentationDelayMs ?? Infinity,
        80.01,
        "映像も通常の深さへ戻ること",
      );
    }),
    { numRuns: 50 },
  );
});

// 壁時計 TIMESTAMP が無い音声でも再生結果は観測できる。基準を捏造せず、穴への
// 適応値を実際の到着基準の再生へ返し、A/V の基準は共有しないことを確かめる。

// 出力の残差を、実際の開始時刻が逆行しない小さな増減で動かす。過去の補償を必要値へ
// 戻す制御では、残差の上限が一定でも共通の待ち時間だけが増え続ける。
test("PlayoutTimeline: 残差の任意の増減でも遅延は必要値の最大を超えず、静まったら戻る", () => {
  fc.assert(
    fc.property(
      fc.array(fc.integer({ min: -10, max: 10 }), { minLength: 50, maxLength: 100 }),
      (steps) => {
        const timeline = new PlayoutTimeline({ timeOriginMs: 0, maxQueuedFrames: 24 });
        let residualMs = 0;
        let previousActual: bigint | null = null;
        for (let index = 0; index < steps.length + 220; index++) {
          residualMs =
            index < steps.length
              ? Math.max(0, Math.min(80, residualMs + (steps[index] ?? 0)))
              : Math.max(0, residualMs - 10);
          const atMs = 1_000 + index * 20;
          const timestamp = atMs * 1_000;
          timeline.observe("audio", atMs, timestamp);
          timeline.observe("video", atMs, timestamp);
          const target = timeline.presentationWallClockMicros("audio", timestamp) ?? 0n;
          const actual = target + BigInt(residualMs * 1_000);
          if (previousActual !== null)
            assert.isAbove(
              Number(actual),
              Number(previousActual),
              "出力時刻が逆行しない入力で検証すること",
            );
          previousActual = actual;
          timeline.recordPresentation("audio", timestamp, actual, target);

          assert.isAtMost(
            timeline.videoDelayMs ?? Infinity,
            160.01,
            "残差の上限以上に補償を重ねないこと",
          );
          assert.isAtLeast(timeline.delayBreakdown.audioPlayoutCorrectionMs, 0);
          assert.isAtMost(timeline.delayBreakdown.audioPlayoutCorrectionMs, 80);
        }
        assert.isBelow(
          timeline.delayBreakdown.audioPlayoutCorrectionMs,
          0.01,
          "静まった残差へ収束すること",
        );
        assert.isAtMost(
          timeline.videoDelayMs ?? Infinity,
          50.01,
          "余分な共通の待ち時間を解放すること",
        );
      },
    ),
    { numRuns: 30 },
  );
});

// 基準の差と、音切れで広がる目標を独立に動かす。時計の差が保護の内側で、キューに
// 余裕がある場合は、制御のたびに音声と映像の予定が不感帯に収まらなければならない。
test("PlayoutTimeline: 穴と回復の任意の列でも既知のバッファ差を補償する", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: -80, max: 80 }),
      fc.array(fc.boolean(), { minLength: 5, maxLength: 40 }),
      (baseDifference, gaps) => {
        const timeline = new PlayoutTimeline({ timeOriginMs: 0, maxQueuedFrames: 24 });
        for (const [index, gap] of gaps.entries()) {
          const atMs = 1_000 + index * 1_000;
          const timestamp = atMs * 1_000;
          timeline.observe("audio", atMs + Math.max(0, baseDifference), timestamp);
          timeline.observe("video", atMs + Math.max(0, -baseDifference), timestamp);
          timeline.observeAudioOutputLead(gap ? 80 : 0, atMs + Math.max(0, baseDifference));

          const { audio, video } = timeline.delayBreakdown;
          assert.isTrue(timeline.sharingBases);
          assert.isAtMost(
            Math.abs((audio.presentationDelayMs ?? 0) - (video.presentationDelayMs ?? 0)),
            5.01,
            "制御を反映した直後から、既知の遅れの差が補償されること",
          );
          assert.isAtMost(timeline.videoDelayMs ?? Infinity, MAX_PLAYOUT_DELAY_MS);
        }
      },
    ),
    { numRuns: 100 },
  );
});
import { JITTER_BUFFER_MAX_QUEUED_FRAMES } from "./buffer";
import {
  MAX_PLAYOUT_DELAY_MS,
  PLAYOUT_WINDOW_MS,
  PLAYOUT_BASE_MAX_DIFFERENCE_MIN_MS,
  PLAYOUT_QUEUE_HEADROOM_FRAMES,
  PLAYOUT_MAX_COMPENSATED_DIFFERENCE_MS,
  SYNC_MIN_DELTA_MS,
  PlayoutTimeline,
  playoutQueueCapMs,
  type PlayoutStream,
  type PlayoutTrackBreakdown,
} from "./timeline";

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

/**
 * キューの上限 (フレーム間隔 × 枚数) の検算で、1 枚あたりに許す丸めの幅 (ミリ秒)
 *
 * 実装はフレーム間隔を TIMESTAMP の差から測る。TIMESTAMP は µs に丸めた値であるため、
 * テストが与えた `frameMs` が µs の整数でないとき、実装が測る間隔は丸めの分だけずれる。
 * CI で落ちた入力では `frameMs = 14.851549421037959` に対して 14.85205078125 ms
 * (+0.50136 µs) であり、その差がキューが吸収できる長さ (間隔 × 枚数) に枚数分だけ効いて
 * いた (20 枚で 0.010027 ms)。ずれの元は µs への丸め (1 つの間隔あたり最大 1 µs) と、
 * 約 1.79e15 µs の倍精度の間隔 (仮数部 0.25 µs) と、ms への変換の丸めであり、1 つの
 * 間隔あたり 2 µs を超えない。この丸めは実装の性質ではなく TIMESTAMP の表現の限界で
 * あるため、テストは丸めの分を枚数分だけ足して比べる
 */
const QUEUE_INTERVAL_ROUNDING_MS = 2 / 1_000;

/** 到着列を作る長さ (ミリ秒) */
const DURATION_MS = 120_000;

/**
 * 合わせない分の検算を許す幅 (ミリ秒)
 *
 * 差は TIMESTAMP の µs から ms への丸めと、分布の窓 (最後の 10 秒) と最後の観測の差だけ
 * ずれる。200 個の seed で確かめた最大のずれは 0.001 ms である
 */
const ALLOWANCE_MS = 0.1;

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
  timeline: PlayoutTimeline;
  records: {
    stream: PlayoutStream;
    mediaMs: number;
    wallClockMs: number;
    offsetMs: number;
    presentationDelayMs: number | null;
    playoutDelayMs: number | null;
    videoDelayMs: number | null;
    presentationWallClockMicros: bigint | null;
  }[];
} {
  const timeline = new PlayoutTimeline({
    timeOriginMs: EPOCH_MS - LOCAL_ORIGIN_MS,
    maxQueuedFrames: MAX_QUEUED_FRAMES,
  });
  const records: {
    stream: PlayoutStream;
    mediaMs: number;
    wallClockMs: number;
    offsetMs: number;
    presentationDelayMs: number | null;
    playoutDelayMs: number | null;
    videoDelayMs: number | null;
    presentationWallClockMicros: bigint | null;
  }[] = [];
  const pending: { stream: PlayoutStream; mediaMs: number; localMs: number }[] = [];
  const mediaMsOf = { audio: 0, video: 0 };
  const outputLocalMsOf = { audio: LOCAL_ORIGIN_MS, video: LOCAL_ORIGIN_MS };
  const sequence: Observation[] = [...operations, { kind: "observe", jitterMs: 30 }];
  let stream: PlayoutStream = "video";
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
        videoDelayMs: timeline.videoDelayMs,
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
      videoDelayMs: timeline.videoDelayMs,
      presentationWallClockMicros: timeline.presentationWallClockMicros(
        next.stream,
        timestampMicros,
      ),
    });
  }
  return { timeline, records };
}

test("PlayoutTimeline: 表示時刻は TIMESTAMP + 基準の遅れ + 表示の遅れ になる", () => {
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
        const stream = last.stream;
        const presentationDelayMs = timeline.delayBreakdown[stream].presentationDelayMs;
        assert.isNotNull(timeline.presentationExtraDelayMs, "最後の観測で音声の遅れが決まること");
        assert.isNotNull(timeline.videoDelayMs, "最後の観測で映像の遅れが決まること");

        // トラックごとの基準の遅れは「観測の時刻 - メディア時刻」の最小値である
        // (観測の軸は performance.now() であり、壁時計から原点を引いた値で観測する)。
        // 実装は直近の窓 (`PLAYOUT_WINDOW_MS`) の最小値を基準にするため、テストも同じ窓で
        // 求める (古い観測まで見ると、実装の基準と食い違って差の判定がずれる)
        const baseOffsetsOf = (target: PlayoutStream): number[] =>
          observations
            .filter(
              (record) =>
                record.stream === target &&
                record.wallClockMs >= last.wallClockMs - PLAYOUT_WINDOW_MS,
            )
            .map((record) => record.offsetMs);
        const audioOffsets = baseOffsetsOf("audio");
        const videoOffsets = baseOffsetsOf("video");
        const ownerBaseMs =
          stream === "audio" ? Math.min(...audioOffsets) : Math.min(...videoOffsets);
        // キューが吸収できる表示の遅れ (表示の遅れの上限)。上限の式は公開されている
        // (`playoutQueueCapMs`) ため、テスト側で同じ式を組み立て直さない
        const queueCapMs = playoutQueueCapMs(MAX_QUEUED_FRAMES, frameMs);
        // 実装の上限は、テストが与えた `frameMs` ではなく TIMESTAMP の差から測った間隔を
        // 枚数分だけ掛けた値である。丸めの分 (1 枚あたり) を枚数分だけ足して比べる
        const queueCapWithRoundingMs =
          queueCapMs +
          (MAX_QUEUED_FRAMES - PLAYOUT_QUEUE_HEADROOM_FRAMES) * QUEUE_INTERVAL_ROUNDING_MS;
        // 2 つの基準の差が閾値を超えると、大きい側は TIMESTAMP を使わない
        const differenceMs =
          audioOffsets.length === 0 || videoOffsets.length === 0
            ? 0
            : Math.abs(Math.min(...audioOffsets) - Math.min(...videoOffsets));
        const delayOfStream =
          stream === "audio" ? timeline.presentationExtraDelayMs : timeline.videoDelayMs;
        // 実装は同期が足した分を含まない遅延で閾値を計算する。ここでは実効値 (足した分を
        // 含む) を使うため、閾値は実装より小さくなる (共有しない側に倒れる)。表示時刻が
        // null になる条件の確認にしか使わないため、この向きで問題ない
        const delayBiggestMs = Math.max(
          timeline.presentationExtraDelayMs ?? 0,
          timeline.videoDelayMs ?? 0,
        );
        const sharingBases =
          differenceMs <= Math.max(PLAYOUT_BASE_MAX_DIFFERENCE_MIN_MS, queueCapMs - delayBiggestMs);

        // 表示時刻 = TIMESTAMP + 基準の遅れ + 表示の遅れ。同じ式を時間軸の外でも計算して
        // 一致を確かめる
        const wallClockMicros = timeline.presentationWallClockMicros(
          stream,
          timestampOf(last.mediaMs),
        );
        if (wallClockMicros === null) {
          // 表示時刻を返さないのは、実装がそのトラックの TIMESTAMP を使わないと決めたときで
          // ある。理由は「差が上限を超えている」「差が動き続けている (時計のずれ)」
          // 「直前にやめた判定を保持している」の 3 つであり、それぞれの規則は単体テストが
          // 固定する。テストが独立に計算できるのは差の大きさだけであるため、差が小さいときは、
          // 動きか保持のどちらかだと実装が報告していることを確かめる
          const unsharedReason = timeline.delayBreakdown.unsharedReason;
          assert.isTrue(
            !sharingBases || unsharedReason === "drift" || unsharedReason === "hold",
            "表示時刻が null なら、基準の差が閾値を超えているか、差が動き続けていること",
          );
          return;
        }
        assert.isNotNull(presentationDelayMs, "表示の遅れが決まること");
        const expectedMicros = Math.round(
          timestampOf(last.mediaMs) + (presentationDelayMs ?? 0) * 1_000,
        );
        assert.closeTo(Number(wallClockMicros), expectedMicros, 1);
        // 表示の遅れ = 自分の基準の遅れ + 自分の jitter buffer の遅延
        assert.closeTo((presentationDelayMs ?? 0) - ownerBaseMs, delayOfStream ?? 0, TOLERANCE_MS);

        // jitter buffer の遅延は 0 以上、上限以下
        assert.isAtLeast(delayOfStream ?? -1, 0);
        assert.isAtMost(
          delayOfStream ?? Infinity,
          queueCapWithRoundingMs,
          "jitter buffer の遅延がキューの上限 (TIMESTAMP の丸めの分を含む) に収まること",
        );
        // 上限は、実装が公開している最大値も超えない。キューの上限と同じ式をテスト側で
        // 持たないため、こちらは式の変更に追随しない独立の bound である
        assert.isAtMost(
          delayOfStream ?? Infinity,
          MAX_PLAYOUT_DELAY_MS,
          "jitter buffer の遅延が公開している最大値を超えないこと",
        );
      },
    ),
    { numRuns: 50 },
  );
}, 10_000);

test("PlayoutTimeline: 同時刻の表示時刻の差は上限に収まり、null は基準がずれた側だけになる", () => {
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
        const otherStream: PlayoutStream = last.stream === "video" ? "audio" : "video";
        const otherWallClockMicros = timeline.presentationWallClockMicros(
          otherStream,
          timestampMicros,
        );
        if (lastWallClockMicros === null || otherWallClockMicros === null) {
          // 長い停止の後に基準の差が閾値を超えると、ずれた側は表示時刻を返さない。
          // どちらも返さないのは、まだ基準が無いときだけである
          if (lastWallClockMicros === null && otherWallClockMicros === null) {
            assert.isNull(
              timeline.delayBreakdown[last.stream].presentationDelayMs ??
                timeline.delayBreakdown[otherStream].presentationDelayMs,
            );
            return;
          }
          const missing = lastWallClockMicros === null ? last.stream : otherStream;
          assert.isNull(
            timeline.delayBreakdown[missing].presentationDelayMs,
            "返さない側は基準がずれている",
          );
          assert.isFalse(timeline.sharingBases, "基準を共有していないこと");
          return;
        }
        // 音声と映像はそれぞれ自分の jitter buffer の遅延を使うため一致はしない。
        // 差は表示の遅れの上限 (キューが吸収できる長さと MAX_PLAYOUT_DELAY_MS の小さい方)
        // を超えない
        const differenceMs = Math.abs(Number(lastWallClockMicros) - Number(otherWallClockMicros));
        assert.isAtMost(differenceMs / 1_000, MAX_PLAYOUT_DELAY_MS, "ずれが上限を超えないこと");
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
function buildArrivals(seed: number): { stream: PlayoutStream; atMs: number; mediaMs: number }[] {
  const durationMs = DURATION_MS;
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
  const arrivals: { stream: PlayoutStream; atMs: number; mediaMs: number }[] = [];
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

/**
 * 2 つのトラックの素の表示の遅れ (基準の遅れ + jitter buffer の遅延) の差 (ミリ秒)
 *
 * 同期の制御が足す前の差である。合わせる量の上限はこの差に掛かる
 */
function naturalDifferenceMsOf(timeline: PlayoutTimeline): number {
  const breakdown = timeline.delayBreakdown;
  const naturalOf = (track: PlayoutTrackBreakdown): number =>
    (track.baseDelayMs ?? 0) + (track.jitterDelayMs ?? 0);
  return Math.abs(naturalOf(breakdown.audio) - naturalOf(breakdown.video));
}

/**
 * 120 秒の到着列を時間軸へ与え、最後の 10 秒の同時刻の表示時刻の差の最大値を求める
 *
 * @returns 時間軸 (skewMs の検算に使う) と、差の最大値 (ミリ秒)
 */
function runArrivals(seed: number): { timeline: PlayoutTimeline; maxDifferenceMs: number } {
  const timeline = new PlayoutTimeline({
    timeOriginMs: EPOCH_MS,
    maxQueuedFrames: MAX_QUEUED_FRAMES,
  });
  const durationMs = DURATION_MS;
  const videoFrameMs = 1_000 / 30;
  for (const arrival of buildArrivals(seed)) {
    timeline.observe(arrival.stream, arrival.atMs, timestampOf(arrival.mediaMs));
  }

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
  return { timeline, maxDifferenceMs };
}

// 基準の差には上限 (PLAYOUT_MAX_COMPENSATED_DIFFERENCE_MS = 100 ms) を常に掛けるため、
// 120 秒の到着列で同時刻の表示時刻の差が必ず ±50 ms に収まるとは限らない。
// 実測では、音声の TIMESTAMP が 600 ms 段差でずれ、その段差を揺らぎとして学習した音声の
// 遅延へ映像を合わせて 600 ms を足し、映像が 500 ms 遅れたまま数十秒戻らなかった。いまは
// 基準の差の補償を制限し、既知のバッファ差だけを別に補償する
test("PlayoutTimeline: 120 秒の到着列でも同時刻の表示時刻の差は合わせない分に収まる", () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 1_000_000 }), (seed) => {
      const { timeline, maxDifferenceMs } = runArrivals(seed);
      // 2 つのトラックの素の表示の遅れの差 (同期の制御が足す前)。合わせる量の上限はこの差に
      // 掛かる
      const naturalDifferenceMs = naturalDifferenceMsOf(timeline);
      // 合わせるのは上限 (PLAYOUT_MAX_COMPENSATED_DIFFERENCE_MS) までであり、超えた分は
      // A/V のずれとして残す。差が上限の中にあるときだけ不感帯 (SYNC_MIN_DELTA_MS) に収まる
      const allowedDifferenceMs = Math.max(
        SYNC_MIN_DELTA_MS,
        naturalDifferenceMs - PLAYOUT_MAX_COMPENSATED_DIFFERENCE_MS,
      );
      // 基準を共有できない場合の復帰中には、以前の補償が残ることがある。
      const breakdown = timeline.delayBreakdown;
      const audioDelayMs =
        (breakdown.audio.baseDelayMs ?? 0) +
        (breakdown.audio.jitterDelayMs ?? 0) +
        breakdown.audio.syncExtraDelayMs;
      const videoDelayMs =
        (breakdown.video.baseDelayMs ?? 0) +
        (breakdown.video.jitterDelayMs ?? 0) +
        breakdown.video.syncExtraDelayMs;
      const trailingExtraMs =
        audioDelayMs >= videoDelayMs
          ? breakdown.audio.syncExtraDelayMs
          : breakdown.video.syncExtraDelayMs;

      // 丸め (TIMESTAMP の µs 変換) と、分布の窓と最後の観測の差を許す幅 (ミリ秒)
      assert.isAtMost(
        maxDifferenceMs,
        allowedDifferenceMs + trailingExtraMs + ALLOWANCE_MS,
        "同時刻の表示時刻の差が、合わせない分に収まること",
      );
      // 100 ms は時計の基準の差に対する上限。既知のバッファ差は別に補償する。
      const bufferDifferenceMs = Math.abs(
        (breakdown.audio.jitterDelayMs ?? 0) - (breakdown.video.jitterDelayMs ?? 0),
      );
      const compensationBudgetMs = PLAYOUT_MAX_COMPENSATED_DIFFERENCE_MS + bufferDifferenceMs;
      assert.isAtMost(breakdown.audio.syncExtraDelayMs, compensationBudgetMs + TOLERANCE_MS);
      assert.isAtMost(breakdown.video.syncExtraDelayMs, compensationBudgetMs + TOLERANCE_MS);

      // 実績から求める同期ずれは、同じ式で決めた音声と映像の表示時刻の差である。合わせない
      // 分が残るため、ずれの予算 (±50 ms) ではなく、合わせない分までになる
      const timestampMicros = timestampOf(DURATION_MS - 1_000);
      const audioWallClockMicros = timeline.presentationWallClockMicros("audio", timestampMicros);
      const videoWallClockMicros = timeline.presentationWallClockMicros("video", timestampMicros);
      assert.isNotNull(audioWallClockMicros);
      assert.isNotNull(videoWallClockMicros);
      timeline.recordPresentation("audio", timestampMicros, audioWallClockMicros ?? 0n);
      timeline.recordPresentation("video", timestampMicros, videoWallClockMicros ?? 0n);
      const skewMs = timeline.skewMs();
      assert.isNotNull(skewMs, "同期ずれが求まること");
      assert.isAtMost(
        Math.abs(skewMs ?? Infinity),
        allowedDifferenceMs + trailingExtraMs + ALLOWANCE_MS,
        "同期ずれが、合わせない分に収まること",
      );
    }),
    // CI の runner はローカルより遅いため、120 秒の列を作る回数を抑える (1 回で 30 fps と
    // Opus の 120 秒分の観測を回す)
    { numRuns: 5 },
  );
  // ローカルでは数秒で終わるが、CI の遅い runner では 20 秒を超えることがあったため、
  // 実行時間で fail しないよう余裕を持たせる (vite.config.ts の testTimeout は 30 秒)
}, 60_000);

/**
 * 特定した seed の到着列でも、映像を音声の膨らんだ遅延に合わせない
 *
 * 失敗を観測した入力を固定する。音声は 200 ms の遅れを揺らぎとして学習して jitter buffer の
 * 遅延が 220〜240 ms になり、映像との素の差が上限 (100 ms) を超える。修正前はその全額を
 * 映像へ足していたため、映像の表示待ちが音声と同じ 220 ms 前後になり、A/V のずれは
 * 不感帯に収まっていた。方針を変えた理由は実測である (音声の TIMESTAMP が 600 ms 段差で
 * ずれ、段差を揺らぎとして学習した遅延へ映像を合わせて 600 ms 足し、映像が 500 ms 遅れた
 * まま数十秒戻らなかった)。いまは合わせる量が上限までになり、残りは A/V のずれとして残る
 */
test("PlayoutTimeline: 差が開いていた到着列でも映像の表示待ちは自分の揺らぎ + 上限までにする", () => {
  // 722071 は develop の CI が落ちた入力である (fast-check の seed 869714401 が生成した
  // 整数)。修正前は映像へ 102.18 ms 足して上限を超えていた
  for (const seed of [12, 50, 139, 194, 722071]) {
    const { timeline, maxDifferenceMs } = runArrivals(seed);
    const breakdown = timeline.delayBreakdown;
    const videoNaturalMs =
      (breakdown.video.baseDelayMs ?? 0) + (breakdown.video.jitterDelayMs ?? 0);
    // 基準の差に対する上限と、既知のバッファ差を分ける。seed 12 は合計が
    // 100 ms を超えるため、合計そのものに時計の保護を掛けた誤った判定を防ぐ。
    const compensationBudgetMs =
      PLAYOUT_MAX_COMPENSATED_DIFFERENCE_MS +
      Math.abs((breakdown.audio.jitterDelayMs ?? 0) - (breakdown.video.jitterDelayMs ?? 0));
    assert.isAtMost(
      breakdown.video.syncExtraDelayMs,
      compensationBudgetMs + TOLERANCE_MS,
      `seed=${seed} の映像へ足す分が基準とバッファの予算を超えないこと`,
    );
    assert.isAtMost(
      timeline.videoDelayMs ?? Infinity,
      videoNaturalMs + PLAYOUT_MAX_COMPENSATED_DIFFERENCE_MS + ALLOWANCE_MS,
      `seed=${seed} の映像の表示待ちが自分の揺らぎ + 上限に収まること`,
    );
    // 合わせない分が残るため、同時刻の表示時刻の差は不感帯には収まらない。素の差から
    // 上限までの分だけになる
    const allowedDifferenceMs = Math.max(
      SYNC_MIN_DELTA_MS,
      naturalDifferenceMsOf(timeline) - PLAYOUT_MAX_COMPENSATED_DIFFERENCE_MS,
    );
    assert.isAtMost(
      maxDifferenceMs,
      allowedDifferenceMs + ALLOWANCE_MS,
      `seed=${seed} の同時刻の表示時刻の差が合わせない分に収まること`,
    );
  }
}, 30_000);
