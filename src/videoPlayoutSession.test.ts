/**
 * VideoPlayoutSession (共有の映像の表示の組み立て) のテスト
 *
 * `VideoFrame` と canvas / `MediaStreamTrackGenerator` は node 環境に実物が無いため、
 * 既存の検証と同じく記録用の最小オブジェクトを注入する (モジュール置換は行わない)。時間軸
 * (`PlaybackTimeline`) と `PlayoutBuffer` は実物を使い、共有のロジックとして通しで検証する。
 *
 * ライブラリ (`src/createMediaSubscriber.ts`) と devtools (`devtools/src/hooks/useSubscriber.ts`)
 * が同じ実装を使うため、ここで固定した挙動が両方の基準になる。
 */

import { test, assert } from "vite-plus/test";
import {
  VideoDecodeInputs,
  VideoPlayoutSession,
  type VideoPlayoutOutput,
  type VideoPlayoutTiming,
} from "./videoPlayoutSession";
import { JITTER_BUFFER_MAX_QUEUED_FRAMES } from "./playoutBuffer";
import { PlaybackTimeline } from "./playbackTimeline";

/**
 * 時間軸の基準にする時刻 (ミリ秒)
 *
 * 表示時刻は `performance.now()` の軸で決まる。テストはここから作った時刻だけを使い、
 * 実時間の進行に依存しないようにする
 */
const TIME_ORIGIN_MS = performance.timeOrigin;

/** 現在の時刻 (`performance.now()` のミリ秒) */
function nowMs(): number {
  return performance.now();
}

/** 表示の周期の予約を記録する入れ物 (node 環境に requestAnimationFrame が無いため注入する) */
interface RecordedFrameScheduler {
  readonly requestFrame: (callback: () => void) => number;
  readonly cancelFrame: (handle: number) => void;
  /** 予約されたコールバックを 1 つ実行する (予約が無ければ何もしない) */
  runNext(): void;
  /** 予約した回数 */
  readonly requestedCount: number;
  /** 取り消された予約の番号 */
  readonly cancelled: number[];
  /** 今も予約が残っているか */
  readonly pending: boolean;
}

/** 表示の周期の予約を記録する入れ物を作る */
function makeFrameScheduler(): RecordedFrameScheduler {
  const callbacks = new Map<number, () => void>();
  const cancelled: number[] = [];
  let nextHandle = 1;
  let requestedCount = 0;
  return {
    requestFrame: (callback) => {
      requestedCount++;
      const handle = nextHandle++;
      callbacks.set(handle, callback);
      return handle;
    },
    cancelFrame: (handle) => {
      cancelled.push(handle);
      callbacks.delete(handle);
    },
    runNext: () => {
      const first = callbacks.entries().next();
      if (first.done === true) {
        return;
      }
      const [handle, callback] = first.value;
      callbacks.delete(handle);
      callback();
    },
    get requestedCount() {
      return requestedCount;
    },
    get cancelled() {
      return cancelled;
    },
    get pending() {
      return callbacks.size > 0;
    },
  };
}

/** 復号したフレームを模した最小の `VideoFrame` */
interface RecordedVideoFrame {
  readonly frame: VideoFrame;
  /** 閉じられたか */
  readonly isClosed: () => boolean;
}

/** 復号したフレームを作る */
function makeVideoFrame(timestamp: number): RecordedVideoFrame {
  let closed = false;
  const frame = {
    timestamp,
    close: () => {
      closed = true;
    },
  } as unknown as VideoFrame;
  return { frame, isClosed: () => closed };
}

/** 表示したフレームの記録 */
interface RecordedPresent {
  /** フレームの TIMESTAMP */
  readonly timestamp: number;
  /** 表示時刻 (`performance.now()` のミリ秒)。決められなかったときは null */
  readonly presentationMs: number | null;
}

/** 表示の出し先の記録用オブジェクト */
interface RecordedOutput {
  readonly output: VideoPlayoutOutput;
  /** フレームを出せるかを切り替える (購読が終わった状態を作る) */
  setAvailable(value: boolean): void;
  /** 実際に表示できたかを切り替える (canvas が無い状態を作る) */
  setPresented(value: boolean): void;
  /** 表示を頼まれたフレーム (実際に表示したかによらず記録する) */
  readonly requested: RecordedPresent[];
  /** 実際に表示したフレーム */
  readonly presented: RecordedPresent[];
}

/** 表示の出し先を作る */
function makeRecordingOutput(): RecordedOutput {
  let available = true;
  let presented = true;
  const requested: RecordedPresent[] = [];
  const presentedFrames: RecordedPresent[] = [];
  return {
    output: {
      isAvailable: () => available,
      present: (frame, presentationMs) => {
        const record = { timestamp: frame.timestamp, presentationMs };
        requested.push(record);
        if (!presented) {
          return false;
        }
        presentedFrames.push(record);
        return true;
      },
    },
    setAvailable: (value) => {
      available = value;
    },
    setPresented: (value) => {
      presented = value;
    },
    get requested() {
      return requested;
    },
    get presented() {
      return presentedFrames;
    },
  };
}

/** 計器の記録用オブジェクト */
interface RecordedTiming {
  readonly timing: VideoPlayoutTiming;
  /** あふれて捨てたフレームの TIMESTAMP */
  readonly queueDrops: number[];
  /** 間に合わなかったフレームの TIMESTAMP と表示時刻 */
  readonly lateDrops: RecordedPresent[];
}

/** 計器を作る */
function makeRecordingTiming(): RecordedTiming {
  const queueDrops: number[] = [];
  const lateDrops: RecordedPresent[] = [];
  return {
    timing: {
      recordQueueDrop: (timestamp) => {
        queueDrops.push(timestamp);
      },
      recordLateDrop: (timestamp, presentationMs) => {
        lateDrops.push({ timestamp, presentationMs });
      },
    },
    get queueDrops() {
      return queueDrops;
    },
    get lateDrops() {
      return lateDrops;
    },
  };
}

/** まだ何も観測していない時間軸を作る (表示時刻を決められない状態) */
function makeEmptyTimeline(): PlaybackTimeline {
  return new PlaybackTimeline({
    timeOriginMs: TIME_ORIGIN_MS,
    maxQueuedFrames: JITTER_BUFFER_MAX_QUEUED_FRAMES,
  });
}

/**
 * 過去に観測した基準を持つ時間軸を作る
 *
 * 映像の基準を `observedMs` で観測する。表示時刻は「観測した時刻 + 表示の遅れ」になるため、
 * 過去の時刻で観測した TIMESTAMP のフレームは表示時刻を過ぎている (すぐ表示できる)。
 *
 * @param observedMs - 観測する時刻 (`performance.now()` の軸、ミリ秒)
 * @param targetLatencyMs - 表示の遅れの下限 (ミリ秒)。指定すると表示時刻が未来に残る
 * @returns 時間軸と、観測に使った TIMESTAMP (Unix epoch マイクロ秒)
 */
function makeTimeline(
  observedMs: number,
  targetLatencyMs?: number,
): { timeline: PlaybackTimeline; timestampMicros: number } {
  const timeline = makeEmptyTimeline();
  if (targetLatencyMs !== undefined) {
    timeline.setTargetLatencyMs(targetLatencyMs);
  }
  const timestampMicros = Math.round((TIME_ORIGIN_MS + observedMs) * 1_000);
  timeline.observe("video", TIME_ORIGIN_MS + observedMs, timestampMicros);
  return { timeline, timestampMicros };
}

/** テストで使う共有の組み立てを作る (表示の出し先と時間軸は記録用の実物) */
function makeSession(options: {
  timeline: PlaybackTimeline;
  output: RecordedOutput;
  timing?: VideoPlayoutTiming;
  maxQueuedFrames?: number;
  drainImmediately: boolean;
  framesPerDrain: number;
  decodeInputs?: VideoDecodeInputs;
}): { session: VideoPlayoutSession; scheduler: RecordedFrameScheduler } {
  const scheduler = makeFrameScheduler();
  const session = new VideoPlayoutSession({
    timeline: options.timeline,
    output: options.output.output,
    decodeInputs:
      options.decodeInputs ?? new VideoDecodeInputs({ maxTracked: 8, forgetOnDuplicate: true }),
    pacing: {
      drainImmediately: options.drainImmediately,
      framesPerDrain: options.framesPerDrain,
    },
    ...(options.timing === undefined ? {} : { timing: options.timing }),
    ...(options.maxQueuedFrames === undefined ? {} : { maxQueuedFrames: options.maxQueuedFrames }),
    requestFrame: scheduler.requestFrame,
    cancelFrame: scheduler.cancelFrame,
  });
  return { session, scheduler };
}

/**
 * 表示時刻を決められない (TIMESTAMP を持たない) フレームを渡す
 *
 * 到着の順に 1 枚ずつ表示する経路であり、実時間に依存せずにキューの扱いを検証できる。
 */
function handleArrivalOrderFrame(
  session: VideoPlayoutSession,
  timestamp: number,
): RecordedVideoFrame {
  const recorded = makeVideoFrame(timestamp);
  session.handleDecodedFrame({
    frame: recorded.frame,
    timestampKind: "none",
    useTimeline: true,
  });
  return recorded;
}

// ============================================================================
// VideoDecodeInputs (復号へ渡したフレームの対応表)
// ============================================================================

test("VideoDecodeInputs: TIMESTAMP の種類と位置を覚え、引くと忘れる", () => {
  const inputs = new VideoDecodeInputs({ maxTracked: 8, forgetOnDuplicate: true });
  inputs.remember(1_000, {
    timestampKind: "wallClock",
    location: { group: 3n, object: 7n },
  });

  assert.equal(inputs.size, 1);
  const input = inputs.take(1_000);
  assert.equal(input?.timestampKind, "wallClock");
  assert.equal(input?.location.group, 3n);
  assert.equal(input?.location.object, 7n);
  // 1 つの TIMESTAMP につき 1 回だけ引ける (復号の出力は 1 つ)
  assert.isUndefined(inputs.take(1_000));
  assert.equal(inputs.size, 0);
});

test("VideoDecodeInputs: TIMESTAMP を持たない Object は覚えず、覚えていた分も忘れる", () => {
  const inputs = new VideoDecodeInputs({ maxTracked: 8, forgetOnDuplicate: true });
  // TIMESTAMP を持たない Object は decoder へ 0 を渡すため、0 で引けると誤って対応づける
  inputs.remember(0, { timestampKind: "none", location: { group: 0n, object: 0n } });
  assert.isUndefined(inputs.take(0));

  inputs.remember(1_000, { timestampKind: "wallClock", location: { group: 1n, object: 1n } });
  inputs.remember(1_000, { timestampKind: "none", location: { group: 1n, object: 2n } });
  assert.isUndefined(inputs.take(1_000));
});

test("VideoDecodeInputs: 同じ TIMESTAMP が重なったら、位置を使うときは忘れる", () => {
  const inputs = new VideoDecodeInputs({ maxTracked: 8, forgetOnDuplicate: true });
  inputs.remember(1_000, { timestampKind: "wallClock", location: { group: 1n, object: 1n } });
  inputs.remember(1_000, { timestampKind: "wallClock", location: { group: 2n, object: 1n } });

  // どちらの位置か決められないため、復号の出力では位置が分からないものとして扱う
  assert.isUndefined(inputs.take(1_000));
});

test("VideoDecodeInputs: 同じ TIMESTAMP が重なったら、位置を使わないときは上書きする", () => {
  const inputs = new VideoDecodeInputs({ maxTracked: 8, forgetOnDuplicate: false });
  inputs.remember(1_000, { timestampKind: "mediaTime", location: { group: 1n, object: 1n } });
  inputs.remember(1_000, { timestampKind: "wallClock", location: { group: 2n, object: 1n } });

  // 後から来た種類で上書きする (表示時刻を決められるかどうかだけを見る)
  assert.equal(inputs.take(1_000)?.timestampKind, "wallClock");
});

test("VideoDecodeInputs: 上限を超えたら古い方から忘れる", () => {
  const inputs = new VideoDecodeInputs({ maxTracked: 2, forgetOnDuplicate: true });
  inputs.remember(1_000, { timestampKind: "wallClock", location: { group: 1n, object: 1n } });
  inputs.remember(2_000, { timestampKind: "wallClock", location: { group: 1n, object: 2n } });
  inputs.remember(3_000, { timestampKind: "wallClock", location: { group: 1n, object: 3n } });

  assert.equal(inputs.size, 2);
  // 出力されなかった分が残り続けない
  assert.isUndefined(inputs.take(1_000));
  assert.isDefined(inputs.take(2_000));
  assert.isDefined(inputs.take(3_000));
});

test("VideoDecodeInputs: clear() ですべて忘れる", () => {
  const inputs = new VideoDecodeInputs({ maxTracked: 8, forgetOnDuplicate: true });
  inputs.remember(1_000, { timestampKind: "wallClock", location: { group: 1n, object: 1n } });
  inputs.clear();
  assert.equal(inputs.size, 0);
});

// ============================================================================
// handleDecodedFrame (復号したフレームの表示)
// ============================================================================

test("handleDecodedFrame: 出し先が無いときは表示せずに閉じ、時間軸へも記録しない", () => {
  const timeline = makeEmptyTimeline();
  const output = makeRecordingOutput();
  output.setAvailable(false);
  const { session, scheduler } = makeSession({
    timeline,
    output,
    drainImmediately: true,
    framesPerDrain: Number.POSITIVE_INFINITY,
  });

  const recorded = makeVideoFrame(1_700_000_000_000_000);
  const result = session.handleDecodedFrame({
    frame: recorded.frame,
    timestampKind: "wallClock",
    useTimeline: true,
  });

  assert.equal(result.status, "skipped");
  assert.isTrue(recorded.isClosed(), "表示しないフレームを閉じていない");
  assert.equal(session.playout.size, 0);
  // 表示しないときは時間軸へも記録しない (基準を作らない)
  assert.isNull(timeline.presentationPerformanceMs("video", 1_700_000_000_000_000));
  assert.isFalse(scheduler.pending);
});

test("handleDecodedFrame: 壁時計の TIMESTAMP を時間軸へ記録し、表示時刻を過ぎたフレームを出す", () => {
  // 1 秒前に観測した TIMESTAMP は、表示時刻 (観測時刻 + 表示の遅れ) を既に過ぎている
  const { timeline, timestampMicros } = makeTimeline(nowMs() - 1_000);
  const output = makeRecordingOutput();
  const { session, scheduler } = makeSession({
    timeline,
    output,
    drainImmediately: true,
    framesPerDrain: Number.POSITIVE_INFINITY,
  });

  const recorded = makeVideoFrame(timestampMicros);
  const result = session.handleDecodedFrame({
    frame: recorded.frame,
    timestampKind: "wallClock",
    useTimeline: true,
  });

  assert.equal(result.status, "queued");
  assert.equal(result.status === "queued" ? result.wallClockTimestamp : null, timestampMicros);
  // 表示時刻を過ぎたフレームは、その場で出し先へ渡る
  assert.deepEqual(
    output.presented.map((present) => present.timestamp),
    [timestampMicros],
  );
  assert.equal(
    output.presented[0]?.presentationMs,
    timeline.presentationPerformanceMs("video", timestampMicros),
  );
  // キューが空になったため、表示周期の予約は残らない
  assert.isFalse(scheduler.pending);
  assert.equal(scheduler.requestedCount, 0);
  assert.equal(session.playout.size, 0);
  // 出し先へ所有権が移る (この中では閉じない)
  assert.isFalse(recorded.isClosed());
});

test("handleDecodedFrame: 表示時刻を過ぎていないフレームはキューに残し、表示周期へ予約する", async () => {
  // targetLatency を下限にすると、観測した直後のフレームの表示時刻も未来に残る
  const targetLatencyMs = 120;
  const { timeline, timestampMicros } = makeTimeline(nowMs(), targetLatencyMs);
  const output = makeRecordingOutput();
  const { session, scheduler } = makeSession({
    timeline,
    output,
    drainImmediately: true,
    framesPerDrain: Number.POSITIVE_INFINITY,
  });

  session.handleDecodedFrame({
    frame: makeVideoFrame(timestampMicros).frame,
    timestampKind: "wallClock",
    useTimeline: true,
  });

  const presentationMs = timeline.presentationPerformanceMs("video", timestampMicros);
  assert.isNotNull(presentationMs);
  assert.isAbove(presentationMs ?? 0, nowMs(), "表示時刻を過ぎたフレームを積んだ");
  assert.equal(output.requested.length, 0);
  assert.equal(session.playout.size, 1);
  assert.isTrue(scheduler.pending, "表示周期へ予約していない");

  // 表示時刻が来たら、予約した表示周期がそのフレームを出す
  while (nowMs() < (presentationMs ?? 0)) {
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
  }
  scheduler.runNext();
  assert.deepEqual(
    output.presented.map((present) => present.timestamp),
    [timestampMicros],
  );
});

test("handleDecodedFrame: メディア時刻と時間軸を使わないときは、届いた順に表示する", () => {
  const { timeline, timestampMicros } = makeTimeline(nowMs() - 1_000);
  const output = makeRecordingOutput();
  const { session } = makeSession({
    timeline,
    output,
    drainImmediately: true,
    framesPerDrain: Number.POSITIVE_INFINITY,
  });

  // メディア時刻 (Timescale あり) は映像の表示時刻と対応しない
  const mediaTime = makeVideoFrame(timestampMicros);
  const mediaTimeResult = session.handleDecodedFrame({
    frame: mediaTime.frame,
    timestampKind: "mediaTime",
    useTimeline: true,
  });
  assert.equal(mediaTimeResult.status === "queued" ? mediaTimeResult.wallClockTimestamp : 1, null);
  assert.deepEqual(
    output.presented.map((present) => present.presentationMs),
    [null],
  );

  // 時間軸を使わない (jitter buffer が無効) ときも、壁時計の TIMESTAMP は使わない
  const disabled = makeVideoFrame(timestampMicros + 1_000);
  const disabledResult = session.handleDecodedFrame({
    frame: disabled.frame,
    timestampKind: "wallClock",
    useTimeline: false,
  });
  assert.equal(disabledResult.status === "queued" ? disabledResult.wallClockTimestamp : 1, null);
  assert.deepEqual(
    output.presented.map((present) => present.presentationMs),
    [null, null],
  );
});

test("handleDecodedFrame: 表示時刻を決めたフレームだけ、表示の実績を時間軸へ記録する", () => {
  const { timeline, timestampMicros } = makeTimeline(nowMs() - 1_000);
  const output = makeRecordingOutput();
  const { session } = makeSession({
    timeline,
    output,
    drainImmediately: true,
    framesPerDrain: Number.POSITIVE_INFINITY,
  });

  session.handleDecodedFrame({
    frame: makeVideoFrame(timestampMicros).frame,
    timestampKind: "wallClock",
    useTimeline: true,
  });
  // 音声の実績も同じ TIMESTAMP で記録する。両方の実績が揃ったときだけ同期ずれの推定が出る
  // (`PlaybackTimeline.skewMs` の JSDoc) ため、推定が出ることで映像の実績が記録されたと分かる
  timeline.recordPresentation(
    "audio",
    timestampMicros,
    BigInt(Math.round((TIME_ORIGIN_MS + nowMs()) * 1_000)),
  );

  const skewMs = timeline.skewMs();
  assert.isNotNull(skewMs, "映像の表示の実績が記録されていない");
  // どちらもほぼ同じ遅れで表示したため、同期のずれは小さい
  assert.isBelow(Math.abs(skewMs ?? Number.NaN), 100);
});

test("handleDecodedFrame: 実際に表示できなかったフレームの実績は記録しない", () => {
  const { timeline, timestampMicros } = makeTimeline(nowMs() - 1_000);
  const output = makeRecordingOutput();
  // canvas が無い (出し先が出せない) 状態
  output.setPresented(false);
  const { session } = makeSession({
    timeline,
    output,
    drainImmediately: true,
    framesPerDrain: Number.POSITIVE_INFINITY,
  });

  session.handleDecodedFrame({
    frame: makeVideoFrame(timestampMicros).frame,
    timestampKind: "wallClock",
    useTimeline: true,
  });
  assert.equal(output.requested.length, 1);
  assert.equal(output.presented.length, 0);
  // 音声の実績だけを記録しても、映像の実績が無いため同期ずれの推定は出ない
  timeline.recordPresentation(
    "audio",
    timestampMicros,
    BigInt(Math.round((TIME_ORIGIN_MS + nowMs()) * 1_000)),
  );
  assert.isNull(timeline.skewMs());
});

test("handleDecodedFrame: 表示待ちの上限を超えたフレームは計器へ記録して閉じる", () => {
  const timeline = makeEmptyTimeline();
  const output = makeRecordingOutput();
  const timing = makeRecordingTiming();
  const { session } = makeSession({
    timeline,
    output,
    timing: timing.timing,
    maxQueuedFrames: 1,
    // 積んだ時点では出さない (あふれを作る)
    drainImmediately: false,
    framesPerDrain: Number.POSITIVE_INFINITY,
  });

  const first = handleArrivalOrderFrame(session, 1_000);
  const second = handleArrivalOrderFrame(session, 2_000);

  assert.deepEqual(timing.queueDrops, [1_000]);
  assert.isTrue(first.isClosed(), "あふれて捨てたフレームを閉じていない");
  assert.equal(session.playout.size, 1);
  assert.isFalse(second.isClosed());
});

test("handleDecodedFrame: 表示周期に 1 枚だけ出す (devtools の進め方)", () => {
  const timeline = makeEmptyTimeline();
  const output = makeRecordingOutput();
  const { session, scheduler } = makeSession({
    timeline,
    output,
    drainImmediately: false,
    framesPerDrain: 1,
  });

  handleArrivalOrderFrame(session, 1_000);
  handleArrivalOrderFrame(session, 2_000);

  // 表示周期が来るまでは出さない
  assert.equal(output.requested.length, 0);
  assert.isTrue(scheduler.pending);
  assert.equal(scheduler.requestedCount, 1, "表示周期の予約を積み増した");

  scheduler.runNext();
  assert.deepEqual(
    output.presented.map((present) => present.timestamp),
    [1_000],
  );
  // まだ表示待ちが残っているため、次の表示周期を予約する
  assert.isTrue(scheduler.pending);
  scheduler.runNext();
  assert.deepEqual(
    output.presented.map((present) => present.timestamp),
    [1_000, 2_000],
  );
  assert.isFalse(scheduler.pending);
});

test("handleDecodedFrame: 1 つの表示周期ですべて出す (ライブラリの進め方)", () => {
  const timeline = makeEmptyTimeline();
  const output = makeRecordingOutput();
  const { session, scheduler } = makeSession({
    timeline,
    output,
    drainImmediately: true,
    framesPerDrain: Number.POSITIVE_INFINITY,
  });

  handleArrivalOrderFrame(session, 1_000);
  handleArrivalOrderFrame(session, 2_000);

  // 表示時刻を決められないフレームは、積んだ時点で順に出す
  assert.deepEqual(
    output.presented.map((present) => present.timestamp),
    [1_000, 2_000],
  );
  assert.equal(session.playout.size, 0);
  assert.isFalse(scheduler.pending);
});

test("handleDecodedFrame: 間に合わなかったフレームは計器へ記録して閉じる", () => {
  // 1 秒前に観測した TIMESTAMP を持つ 3 枚を積む。古い 2 枚は表示時刻から 20 ms を超えて
  // 遅れているため捨てられ、最新の 1 枚だけが描かれる
  const { timeline, timestampMicros } = makeTimeline(nowMs() - 1_000);
  const output = makeRecordingOutput();
  const timing = makeRecordingTiming();
  const { session, scheduler } = makeSession({
    timeline,
    output,
    timing: timing.timing,
    drainImmediately: false,
    framesPerDrain: 1,
  });

  const frames = [0, 33_000, 66_000].map((offset) => makeVideoFrame(timestampMicros + offset));
  for (const recorded of frames) {
    session.handleDecodedFrame({
      frame: recorded.frame,
      timestampKind: "wallClock",
      useTimeline: true,
    });
  }
  assert.equal(session.playout.size, 3);

  scheduler.runNext();
  assert.deepEqual(
    timing.lateDrops.map((late) => late.timestamp),
    [timestampMicros, timestampMicros + 33_000],
  );
  for (const late of timing.lateDrops) {
    assert.isNotNull(late.presentationMs, "間に合わなかったフレームの表示時刻を記録していない");
  }
  assert.isTrue(frames[0]?.isClosed(), "間に合わなかったフレームを閉じていない");
  assert.isTrue(frames[1]?.isClosed(), "間に合わなかったフレームを閉じていない");
  assert.deepEqual(
    output.presented.map((present) => present.timestamp),
    [timestampMicros + 66_000],
  );
});

test("clear(): 予約を取り消し、表示待ちと対応表を捨てる", () => {
  const timeline = makeEmptyTimeline();
  const output = makeRecordingOutput();
  const decodeInputs = new VideoDecodeInputs({ maxTracked: 8, forgetOnDuplicate: true });
  decodeInputs.remember(1_000, {
    timestampKind: "wallClock",
    location: { group: 1n, object: 1n },
  });
  const { session, scheduler } = makeSession({
    timeline,
    output,
    decodeInputs,
    drainImmediately: false,
    framesPerDrain: Number.POSITIVE_INFINITY,
  });

  const recorded = handleArrivalOrderFrame(session, 1_000);
  assert.equal(session.playout.size, 1);
  assert.isTrue(scheduler.pending);

  session.clear();

  assert.equal(session.playout.size, 0);
  assert.isTrue(recorded.isClosed(), "表示待ちのフレームを閉じていない");
  assert.equal(scheduler.cancelled.length, 1);
  assert.isFalse(scheduler.pending);
  assert.equal(decodeInputs.size, 0);
});

test("clear(): 表示している間に出し先が無くなったら、表示待ちを捨てる", () => {
  const timeline = makeEmptyTimeline();
  const output = makeRecordingOutput();
  const { session, scheduler } = makeSession({
    timeline,
    output,
    drainImmediately: false,
    framesPerDrain: Number.POSITIVE_INFINITY,
  });

  const recorded = handleArrivalOrderFrame(session, 1_000);
  assert.equal(session.playout.size, 1);

  // 購読が終わった (出し先が無くなった) 後に表示周期が来た場合、出せないフレームを
  // 残さない
  output.setAvailable(false);
  scheduler.runNext();
  assert.equal(session.playout.size, 0);
  assert.isTrue(recorded.isClosed(), "出せないフレームを閉じていない");
  assert.isFalse(scheduler.pending);
});

test("handleDecodedFrame: 基準を取り直した後に残ったフレームは表示時刻を決めずに出す", () => {
  // targetLatency を下限にして、表示時刻が未来に残るフレームを積む
  const { timeline, timestampMicros } = makeTimeline(nowMs(), 120);
  const output = makeRecordingOutput();
  const { session, scheduler } = makeSession({
    timeline,
    output,
    drainImmediately: false,
    framesPerDrain: 1,
  });

  session.handleDecodedFrame({
    frame: makeVideoFrame(timestampMicros).frame,
    timestampKind: "wallClock",
    useTimeline: true,
  });
  // 基準を取り直す (世代が進む)。積んだときの世代と違うフレームは、新しい基準では表示時刻を
  // 決められないため、届いた順に出す
  timeline.reset();

  scheduler.runNext();
  assert.deepEqual(
    output.presented.map((present) => present.timestamp),
    [timestampMicros],
  );
  assert.isNull(output.presented[0]?.presentationMs ?? null);
});
