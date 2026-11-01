/**
 * VideoPlayoutSession (共有の映像の表示の組み立て) のテスト
 *
 * `VideoFrame` と canvas / `MediaStreamTrackGenerator` は node 環境に実物が無いため、
 * 既存の検証と同じく記録用の最小オブジェクトを注入する (モジュール置換は行わない)。時間軸
 * (`PlayoutTimeline`) と `PlayoutBuffer` は実物を使い、共有のロジックとして通しで検証する。
 *
 * ライブラリ (`src/createMediaSubscriber.ts`) と devtools (`devtools/src/hooks/useSubscriber.ts`)
 * が同じ実装を使うため、ここで固定した挙動が両方の基準になる。
 */

import { test, assert } from "vite-plus/test";
import {
  VideoDecodeInputs,
  VideoPlayoutSession,
  type VideoPlayoutOutput,
  type VideoPlayoutResult,
  type VideoPlayoutTiming,
} from "./videoPlayoutSession";
import { JITTER_BUFFER_MAX_QUEUED_FRAMES } from "./buffer";
import { PlayoutTimeline } from "./timeline";

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
  readonly requestFrame: (callback: (timestampMs: number) => void) => number;
  readonly cancelFrame: (handle: number) => void;
  /** 予約されたコールバックを 1 つ、指定した vsync の時刻で実行する */
  runNext(timestampMs: number): void;
  /** 予約した回数 */
  readonly requestedCount: number;
  /** 取り消された予約の番号 */
  readonly cancelled: number[];
  /** 今も予約が残っているか */
  readonly pending: boolean;
}

/** 表示の周期の予約を記録する入れ物を作る */
function makeFrameScheduler(): RecordedFrameScheduler {
  const callbacks = new Map<number, (timestampMs: number) => void>();
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
    runNext: (timestampMs) => {
      const first = callbacks.entries().next();
      if (first.done === true) {
        return;
      }
      const [handle, callback] = first.value;
      callbacks.delete(handle);
      callback(timestampMs);
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

/**
 * 表示の出し先を作る
 *
 * @param presentationLatencyTicks - 表示先の提示遅延 (表示周期の tick 数)。既定は 0 (canvas)
 */
function makeRecordingOutput(presentationLatencyTicks = 0): RecordedOutput {
  let available = true;
  let presented = true;
  const requested: RecordedPresent[] = [];
  const presentedFrames: RecordedPresent[] = [];
  return {
    output: {
      presentationLatencyTicks,
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
function makeEmptyTimeline(): PlayoutTimeline {
  return new PlayoutTimeline({
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
): { timeline: PlayoutTimeline; timestampMicros: number } {
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
  timeline: PlayoutTimeline;
  output: RecordedOutput;
  timing?: VideoPlayoutTiming;
  maxQueuedFrames?: number;
  now?: () => number;
}): { session: VideoPlayoutSession; scheduler: RecordedFrameScheduler } {
  const scheduler = makeFrameScheduler();
  const session = new VideoPlayoutSession({
    timeline: options.timeline,
    output: options.output.output,
    ...(options.timing === undefined ? {} : { timing: options.timing }),
    ...(options.maxQueuedFrames === undefined ? {} : { maxQueuedFrames: options.maxQueuedFrames }),
    ...(options.now === undefined ? {} : { now: options.now }),
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

/** `makeDefaultSession` で変えられる項目 (省略した項目は既定値を使う) */
interface DefaultSessionOptions {
  /** 使う時間軸。省略すると空の時間軸 (表示時刻を決められない状態) を作る */
  readonly timeline?: PlayoutTimeline;
  /** 使う出し先。省略すると記録用の出し先を作る */
  readonly output?: RecordedOutput;
  /** 計器 (省略すると渡さない) */
  readonly timing?: VideoPlayoutTiming;
  /** 表示待ちの上限 (省略すると時間軸の既定値) */
  readonly maxQueuedFrames?: number;
  /** 現在時刻 (省略すると実時間) */
  readonly now?: () => number;
}

/**
 * 既定の組み立てを作る
 *
 * 空の時間軸と記録用の出し先を使い、表示は rAF の予約を注入して進める。テストは
 * 変えたい項目だけを渡す。
 *
 * @param options - 変えたい項目
 * @returns 時間軸・出し先・セッション・表示周期の記録
 */
function makeDefaultSession(options: DefaultSessionOptions = {}): {
  timeline: PlayoutTimeline;
  output: RecordedOutput;
  session: VideoPlayoutSession;
  scheduler: RecordedFrameScheduler;
} {
  const timeline = options.timeline ?? makeEmptyTimeline();
  const output = options.output ?? makeRecordingOutput();
  const { session, scheduler } = makeSession({
    timeline,
    output,
    ...(options.timing === undefined ? {} : { timing: options.timing }),
    ...(options.maxQueuedFrames === undefined ? {} : { maxQueuedFrames: options.maxQueuedFrames }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  return { timeline, output, session, scheduler };
}

/** 壁時計の TIMESTAMP を持つフレームを 1 枚渡した結果 */
interface HandledWallClockFrame {
  /** 渡したフレーム (閉じられたかを後で確かめられる) */
  readonly recorded: RecordedVideoFrame;
  /** 表示の判断の結果 */
  readonly result: VideoPlayoutResult;
}

/**
 * 壁時計の TIMESTAMP を持つフレームを 1 枚渡す
 *
 * @param session - 渡す先のセッション
 * @param timestampMicros - フレームの TIMESTAMP (Unix epoch マイクロ秒)
 * @returns 渡したフレームと結果
 */
function handleWallClockFrame(
  session: VideoPlayoutSession,
  timestampMicros: number,
): HandledWallClockFrame {
  const recorded = makeVideoFrame(timestampMicros);
  const result = session.handleDecodedFrame({
    frame: recorded.frame,
    timestampKind: "wallClock",
    useTimeline: true,
  });
  return { recorded, result };
}

/**
 * 壁時計の TIMESTAMP を持つフレームをまとめて渡す
 *
 * @param session - 渡す先のセッション
 * @param timestampsMicros - フレームの TIMESTAMP (Unix epoch マイクロ秒) の並び
 * @returns 渡したフレームの並び (閉じられたかを後で確かめられる)
 */
function handleWallClockFrames(
  session: VideoPlayoutSession,
  timestampsMicros: readonly number[],
): RecordedVideoFrame[] {
  return timestampsMicros.map(
    (timestampMicros) => handleWallClockFrame(session, timestampMicros).recorded,
  );
}

/**
 * 音声の表示の実績を時間軸へ記録する
 *
 * 映像の実績と揃ったときにだけ同期ずれの推定が出るため、映像の実績を記録できたかを
 * 確かめるのに使う。
 *
 * @param timeline - 記録する時間軸
 * @param timestampMicros - 映像と同じ TIMESTAMP (Unix epoch マイクロ秒)
 */
function recordAudioPresentation(timeline: PlayoutTimeline, timestampMicros: number): void {
  timeline.recordPresentation(
    "audio",
    timestampMicros,
    BigInt(Math.round((TIME_ORIGIN_MS + nowMs()) * 1_000)),
  );
}

// ============================================================================
// VideoDecodeInputs (復号へ渡したフレームの対応表)
// ============================================================================

test("VideoDecodeInputs: TIMESTAMP の種類と位置を覚え、引くと忘れる", () => {
  const inputs = new VideoDecodeInputs({ maxTracked: 8 });
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
  const inputs = new VideoDecodeInputs({ maxTracked: 8 });
  // TIMESTAMP を持たない Object は decoder へ 0 を渡すため、0 で引けると誤って対応づける
  inputs.remember(0, { timestampKind: "none", location: { group: 0n, object: 0n } });
  assert.isUndefined(inputs.take(0));

  inputs.remember(1_000, { timestampKind: "wallClock", location: { group: 1n, object: 1n } });
  inputs.remember(1_000, { timestampKind: "none", location: { group: 1n, object: 2n } });
  assert.isUndefined(inputs.take(1_000));
});

test("VideoDecodeInputs: 同じ TIMESTAMP の出力も入力順に位置を引く", () => {
  const inputs = new VideoDecodeInputs({ maxTracked: 8 });
  inputs.remember(1_000, { timestampKind: "wallClock", location: { group: 1n, object: 1n } });
  inputs.remember(1_000, { timestampKind: "wallClock", location: { group: 2n, object: 1n } });

  assert.equal(inputs.take(1_000)?.location.group, 1n);
  assert.equal(inputs.take(1_000)?.location.group, 2n);
  assert.isUndefined(inputs.take(1_000));
});

test("VideoDecodeInputs: 同じ TIMESTAMP の異なる種類を上書きしない", () => {
  const inputs = new VideoDecodeInputs({ maxTracked: 8 });
  inputs.remember(1_000, { timestampKind: "mediaTime", location: { group: 1n, object: 1n } });
  inputs.remember(1_000, { timestampKind: "wallClock", location: { group: 2n, object: 1n } });

  assert.equal(inputs.take(1_000)?.timestampKind, "mediaTime");
  assert.equal(inputs.take(1_000)?.timestampKind, "wallClock");
});

test("VideoDecodeInputs: 上限を超えたら古い方から忘れる", () => {
  const inputs = new VideoDecodeInputs({ maxTracked: 2 });
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
  const inputs = new VideoDecodeInputs({ maxTracked: 8 });
  inputs.remember(1_000, { timestampKind: "wallClock", location: { group: 1n, object: 1n } });
  inputs.clear();
  assert.equal(inputs.size, 0);
});

// ============================================================================
// handleDecodedFrame (復号したフレームの表示)
// ============================================================================

/** 表示時刻 (`performance.now()` の軸) を取り出す */
function presentationOf(timeline: PlayoutTimeline, timestampMicros: number): number {
  const presentationMs = timeline.presentationPerformanceMs("video", timestampMicros);
  assert.isNotNull(presentationMs, "表示時刻が決まること");
  return presentationMs ?? 0;
}

test("handleDecodedFrame: 出し先が無いときは表示せずに閉じ、時間軸へも記録しない", () => {
  const output = makeRecordingOutput();
  output.setAvailable(false);
  const { timeline, session, scheduler } = makeDefaultSession({ output });

  const { recorded, result } = handleWallClockFrame(session, 1_700_000_000_000_000);

  assert.equal(result.status, "skipped");
  assert.isTrue(recorded.isClosed(), "表示しないフレームを閉じていない");
  assert.equal(session.playout.size, 0);
  // 表示しないときは時間軸へも記録しない (基準を作らない)
  assert.isNull(timeline.presentationPerformanceMs("video", 1_700_000_000_000_000));
  assert.isFalse(scheduler.pending);
});

test("handleDecodedFrame: 壁時計の TIMESTAMP を時間軸へ記録し、表示周期で表示する", () => {
  // targetLatency を下限にして、表示時刻が未来に残るフレームを積む
  const { timeline, timestampMicros } = makeTimeline(nowMs(), 120);
  const { output, session, scheduler } = makeDefaultSession({ timeline });

  const { recorded, result } = handleWallClockFrame(session, timestampMicros);

  assert.equal(result.status, "queued");
  assert.equal(result.status === "queued" ? result.wallClockTimestamp : null, timestampMicros);
  // 積んだ時点では出さず、表示周期の予約だけを残す
  assert.equal(output.requested.length, 0);
  assert.isTrue(scheduler.pending, "表示周期へ予約していない");
  assert.equal(session.playout.size, 1);

  const presentationMs = presentationOf(timeline, timestampMicros);
  scheduler.runNext(presentationMs);

  assert.deepEqual(
    output.presented.map((present) => present.timestamp),
    [timestampMicros],
  );
  assert.equal(output.presented[0]?.presentationMs, presentationMs);
  assert.equal(session.playout.size, 0);
  // 表示待ちは空になったが、最後の表示から間もないため予約は続ける
  assert.isTrue(scheduler.pending);
  session.clear();
  assert.isFalse(scheduler.pending);
  // 出し先へ所有権が移る (この中では閉じない)
  assert.isFalse(recorded.isClosed());
});

test("handleDecodedFrame: 目標表示時刻の前の tick では出さず、近い tick で出す", () => {
  // targetLatency を下限にすると、観測した直後のフレームの表示時刻も未来に残る
  const targetLatencyMs = 120;
  const { timeline, timestampMicros } = makeTimeline(nowMs(), targetLatencyMs);
  const { output, session, scheduler } = makeDefaultSession({ timeline });

  handleWallClockFrame(session, timestampMicros);
  const presentationMs = presentationOf(timeline, timestampMicros);

  // 表示時刻より十分前の tick では、目標表示時刻に近いフレームが無いため描かない
  scheduler.runNext(presentationMs - 100);
  assert.equal(output.requested.length, 0);
  assert.equal(session.playout.size, 1);
  assert.isTrue(scheduler.pending, "続きの表示周期へ予約していない");

  // 表示時刻に近い tick では描く
  scheduler.runNext(presentationMs);
  assert.deepEqual(
    output.presented.map((present) => present.timestamp),
    [timestampMicros],
  );
  assert.equal(output.presented[0]?.presentationMs, presentationMs);
});

test("handleDecodedFrame: メディア時刻と時間軸を使わないときは、届いた順に表示する", () => {
  const { timeline, timestampMicros } = makeTimeline(nowMs() - 1_000);
  const { output, session, scheduler } = makeDefaultSession({ timeline });

  // メディア時刻 (Timescale あり) は映像の表示時刻と対応しない
  const mediaTime = makeVideoFrame(timestampMicros);
  const mediaTimeResult = session.handleDecodedFrame({
    frame: mediaTime.frame,
    timestampKind: "mediaTime",
    useTimeline: true,
  });
  assert.equal(mediaTimeResult.status === "queued" ? mediaTimeResult.wallClockTimestamp : 1, null);

  // 時間軸を使わない (jitter buffer が無効) ときも、壁時計の TIMESTAMP は使わない
  const disabled = makeVideoFrame(timestampMicros + 1_000);
  const disabledResult = session.handleDecodedFrame({
    frame: disabled.frame,
    timestampKind: "wallClock",
    useTimeline: false,
  });
  assert.equal(disabledResult.status === "queued" ? disabledResult.wallClockTimestamp : 1, null);

  // 表示周期ごとに 1 枚ずつ、届いた順に描く
  scheduler.runNext(0);
  assert.deepEqual(
    output.presented.map((present) => present.presentationMs),
    [null],
  );
  scheduler.runNext(16.667);
  assert.deepEqual(
    output.presented.map((present) => present.presentationMs),
    [null, null],
  );
});

test("handleDecodedFrame: 表示時刻を決めたフレームだけ、表示の実績を時間軸へ記録する", () => {
  // 表示時刻が直近になるように観測し、表示周期の tick で描く
  const observedMs = nowMs() - 10;
  const { timeline, timestampMicros } = makeTimeline(observedMs);
  const { session, scheduler } = makeDefaultSession({ timeline });

  handleWallClockFrame(session, timestampMicros);
  scheduler.runNext(presentationOf(timeline, timestampMicros));
  // 音声の実績も同じ TIMESTAMP で記録する。両方の実績が揃ったときだけ同期ずれの推定が出る
  // (`PlayoutTimeline.skewMs` の JSDoc) ため、推定が出ることで映像の実績が記録されたと分かる
  recordAudioPresentation(timeline, timestampMicros);

  const skewMs = timeline.skewMs();
  assert.isNotNull(skewMs, "映像の表示の実績が記録されていない");
  // どちらもほぼ同じ遅れで表示したため、同期のずれは小さい
  assert.isBelow(Math.abs(skewMs ?? Number.NaN), 100);
});

test("handleDecodedFrame: 実際に表示できなかったフレームの実績は記録しない", () => {
  const observedMs = nowMs() - 10;
  const { timeline, timestampMicros } = makeTimeline(observedMs);
  const output = makeRecordingOutput();
  // canvas が無い (出し先が出せない) 状態
  output.setPresented(false);
  const { session, scheduler } = makeDefaultSession({ timeline, output });

  handleWallClockFrame(session, timestampMicros);
  scheduler.runNext(presentationOf(timeline, timestampMicros));
  assert.equal(output.requested.length, 1);
  assert.equal(output.presented.length, 0);
  // 音声の実績だけを記録しても、映像の実績が無いため同期ずれの推定は出ない
  recordAudioPresentation(timeline, timestampMicros);
  assert.isNull(timeline.skewMs());
});

test("handleDecodedFrame: 表示待ちの上限を超えたフレームは計器へ記録して閉じる", () => {
  const timing = makeRecordingTiming();
  const { session } = makeDefaultSession({
    timing: timing.timing,
    maxQueuedFrames: 1,
  });

  const first = handleArrivalOrderFrame(session, 1_000);
  const second = handleArrivalOrderFrame(session, 2_000);

  assert.deepEqual(timing.queueDrops, [1_000]);
  assert.isTrue(first.isClosed(), "あふれて捨てたフレームを閉じていない");
  assert.equal(session.playout.size, 1);
  assert.isFalse(second.isClosed());
});

test("handleDecodedFrame: 表示周期に 1 枚だけ出す", () => {
  const { output, session, scheduler } = makeDefaultSession();

  handleArrivalOrderFrame(session, 1_000);
  handleArrivalOrderFrame(session, 2_000);

  // 表示周期が来るまでは出さない
  assert.equal(output.requested.length, 0);
  assert.isTrue(scheduler.pending);
  assert.equal(scheduler.requestedCount, 1, "表示周期の予約を積み増した");

  scheduler.runNext(0);
  assert.deepEqual(
    output.presented.map((present) => present.timestamp),
    [1_000],
  );
  // まだ表示待ちが残っているため、次の表示周期を予約する
  assert.isTrue(scheduler.pending);
  scheduler.runNext(16.667);
  assert.deepEqual(
    output.presented.map((present) => present.timestamp),
    [1_000, 2_000],
  );
  // 表示待ちは空になったが、最後の表示から間もないため表示周期の予約は続ける
  assert.isTrue(scheduler.pending);
  session.clear();
  assert.isFalse(scheduler.pending);
});

test("handleDecodedFrame: 目標表示時刻から許容幅を超えて外れたフレームは計器へ記録して閉じる", () => {
  const { timeline, timestampMicros } = makeTimeline(nowMs() - 1_000);
  const timing = makeRecordingTiming();
  const { output, session, scheduler } = makeDefaultSession({
    timeline,
    timing: timing.timing,
  });

  const frames = handleWallClockFrames(session, [
    timestampMicros,
    timestampMicros + 33_000,
    timestampMicros + 66_000,
  ]);
  assert.equal(session.playout.size, 3);

  // 3 枚目の表示時刻を目標にすると、1 枚目と 2 枚目は許容幅 (表示周期の半分) より古い
  const thirdPresentationMs = presentationOf(timeline, timestampMicros + 66_000);
  scheduler.runNext(thirdPresentationMs);
  assert.deepEqual(
    timing.lateDrops.map((late) => late.timestamp),
    [timestampMicros, timestampMicros + 33_000],
  );
  for (const late of timing.lateDrops) {
    assert.isNotNull(late.presentationMs, "捨てたフレームの表示時刻を記録していない");
  }
  assert.isTrue(frames[0]?.isClosed(), "捨てたフレームを閉じていない");
  assert.isTrue(frames[1]?.isClosed(), "捨てたフレームを閉じていない");
  assert.deepEqual(
    output.presented.map((present) => present.timestamp),
    [timestampMicros + 66_000],
  );
});

test("計器の recordLateDrop が throw しても、捨てたフレームを閉じて表示を続ける", () => {
  const { timeline, timestampMicros } = makeTimeline(nowMs() - 1_000);
  const throwing: VideoPlayoutTiming = {
    recordQueueDrop: () => undefined,
    recordLateDrop: () => {
      throw new Error("late drop recorder failed");
    },
  };
  const { output, session, scheduler } = makeDefaultSession({
    timeline,
    timing: throwing,
  });
  const frames = handleWallClockFrames(session, [
    timestampMicros,
    timestampMicros + 33_000,
    timestampMicros + 66_000,
  ]);

  scheduler.runNext(presentationOf(timeline, timestampMicros + 66_000));

  assert.isTrue(frames[0]?.isClosed(), "捨てたフレームを閉じていない");
  assert.isTrue(frames[1]?.isClosed(), "捨てたフレームを閉じていない");
  assert.deepEqual(
    output.presented.map((present) => present.timestamp),
    [timestampMicros + 66_000],
  );
});

test("handleDecodedFrame: 時間軸の表示の遅れが小さくても、提示遅延の分だけ先に書く", () => {
  // targetLatency の無い購読では、時間軸の映像の表示の遅れは 0 に近い。generator は書き込みの
  // 次の vsync で表示されるため、遅れに提示遅延 (1 tick) の下限が無いと、到着位相によっては
  // 書き込みの tick に間に合わず全フレームを捨ててしまう
  const { timeline, timestampMicros } = makeTimeline(nowMs());
  const output = makeRecordingOutput(1);
  const { session, scheduler } = makeDefaultSession({ timeline, output });
  handleWallClockFrame(session, timestampMicros);

  // 到着から 10 ms 後の tick では、下限が無ければ遅れが 1 tick + 10 ms になり捨てられる
  scheduler.runNext(nowMs() + 10);

  assert.deepEqual(
    output.presented.map((present) => present.timestamp),
    [timestampMicros],
    "提示遅延の下限が無いとフレームを捨てている",
  );
});

test("handleDecodedFrame: tick の位相が変わっても推定表示時刻が近い vsync になる", () => {
  // 時間軸の表示の遅れが提示遅延より十分大きい条件では、書き込み tick + R が、表示時刻に
  // 最も近い vsync になる
  for (const refreshMs of [1_000 / 60, 1_000 / 120]) {
    for (const phaseMs of [0, 4, 8.3]) {
      const { timeline, timestampMicros } = makeTimeline(nowMs(), 120);
      const output = makeRecordingOutput(1);
      const { session, scheduler } = makeDefaultSession({ timeline, output });
      handleWallClockFrame(session, timestampMicros);
      const presentationMs = presentationOf(timeline, timestampMicros);

      let presentedTickMs: number | null = null;
      const gridOriginMs = nowMs() + phaseMs;
      for (let index = 0; index < 40; index++) {
        const tickMs = gridOriginMs + index * refreshMs;
        const before = output.presented.length;
        scheduler.runNext(tickMs);
        if (output.presented.length > before) {
          presentedTickMs = tickMs;
          break;
        }
      }
      assert.isNotNull(presentedTickMs, `${refreshMs} ms の tick で表示されなかった`);
      const estimatedDisplayMs = (presentedTickMs ?? 0) + refreshMs;
      // 推定表示時刻が、表示時刻に最も近い vsync であること
      const nearestMs =
        gridOriginMs + Math.round((presentationMs - gridOriginMs) / refreshMs) * refreshMs;
      assert.isAtMost(
        Math.abs(estimatedDisplayMs - nearestMs),
        1,
        `${refreshMs} ms / 位相 ${phaseMs} ms で近い vsync になっていない`,
      );
      assert.isAtMost(Math.abs(estimatedDisplayMs - presentationMs), refreshMs / 2 + 1);
    }
  }
});

test("handleDecodedFrame: 推定表示時刻を同期の実績として記録する", () => {
  // 観測から 10 ms 前のフレームを、表示時刻の 1 tick 前の tick で書く。実績は write の時刻では
  // なく write の次の vsync でなければ、音声の実績と揃わない
  const { timeline, timestampMicros } = makeTimeline(nowMs() - 10);
  const output = makeRecordingOutput(1);
  const { session, scheduler } = makeDefaultSession({ timeline, output });
  handleWallClockFrame(session, timestampMicros);
  const presentationMs = presentationOf(timeline, timestampMicros);
  scheduler.runNext(presentationMs - 1_000 / 60);

  // 音声も同じ表示時刻で記録する
  timeline.recordPresentation(
    "audio",
    timestampMicros,
    BigInt(Math.round((TIME_ORIGIN_MS + presentationMs) * 1_000)),
  );
  const skewMs = timeline.skewMs();
  assert.isNotNull(skewMs, "映像の実績が記録されていない");
  assert.isBelow(Math.abs(skewMs ?? Number.NaN), 1, "write の時刻を表示の実績にしている");
});

test("handleDecodedFrame: 提示遅延の tick 数が不正なら例外にする", () => {
  const timeline = makeEmptyTimeline();
  const options = {
    timeline,
    output: {
      presentationLatencyTicks: -1,
      isAvailable: () => true,
      present: () => true,
    },
  };
  assert.throws(() => new VideoPlayoutSession(options), "presentationLatencyTicks");
  assert.throws(
    () =>
      new VideoPlayoutSession({
        ...options,
        output: { ...options.output, presentationLatencyTicks: 1.5 },
      }),
    "presentationLatencyTicks",
  );
  assert.throws(
    () =>
      new VideoPlayoutSession({
        ...options,
        output: { ...options.output, presentationLatencyTicks: 5 },
      }),
    "presentationLatencyTicks",
  );
  // 上限の 4 は受け付ける
  assert.doesNotThrow(
    () =>
      new VideoPlayoutSession({
        ...options,
        output: { ...options.output, presentationLatencyTicks: 4 },
      }),
  );
});

test("handleDecodedFrame: 最後の表示から 250 ms たつと表示周期の予約を止める", () => {
  let clockMs = 1_000;
  const { session, scheduler } = makeDefaultSession({ now: () => clockMs });
  handleArrivalOrderFrame(session, 1_000);
  scheduler.runNext(clockMs);
  assert.isTrue(scheduler.pending, "表示直後は表示周期の予約を続けること");

  clockMs += 300;
  scheduler.runNext(clockMs);
  assert.isFalse(scheduler.pending, "アイドルが続いても予約を止めていない");
});

test("clear(): 予約を取り消し、表示待ちを捨てる", () => {
  // 復号へ渡した入力の対応表は呼び出し側 (MediaPlayout) が持つため、ここでは消さない
  const { session, scheduler } = makeDefaultSession();

  const recorded = handleArrivalOrderFrame(session, 1_000);
  assert.equal(session.playout.size, 1);
  assert.isTrue(scheduler.pending);

  session.clear();

  assert.equal(session.playout.size, 0);
  assert.isTrue(recorded.isClosed(), "表示待ちのフレームを閉じていない");
  assert.equal(scheduler.cancelled.length, 1);
  assert.isFalse(scheduler.pending);
});

test("計器が throw しても、あふれたフレームを閉じて表示周期を続ける", () => {
  // 計器は throw しない契約だが、実装が失敗してもフレームを閉じ損ねないことを固定する
  const throwing: VideoPlayoutTiming = {
    recordQueueDrop: () => {
      throw new Error("queue drop recorder failed");
    },
    recordLateDrop: () => {
      throw new Error("late drop recorder failed");
    },
  };
  const { session } = makeDefaultSession({
    timing: throwing,
    maxQueuedFrames: 1,
  });

  // 1 枚目で上限に達し、2 枚目の到着で 1 枚目があふれる
  const first = handleArrivalOrderFrame(session, 1_000_000);
  const second = handleArrivalOrderFrame(session, 1_100_000);
  assert.isTrue(first.isClosed(), "あふれたフレームを閉じていない");
  assert.isFalse(second.isClosed(), "残ったフレームを閉じてしまっている");
  assert.equal(session.playout.size, 1);
});

test("clear(): 表示している間に出し先が無くなったら、表示待ちを捨てる", () => {
  const { output, session, scheduler } = makeDefaultSession();

  const recorded = handleArrivalOrderFrame(session, 1_000);
  assert.equal(session.playout.size, 1);

  // 購読が終わった (出し先が無くなった) 後に表示周期が来た場合、出せないフレームを
  // 残さない
  output.setAvailable(false);
  scheduler.runNext(0);
  assert.equal(session.playout.size, 0);
  assert.isTrue(recorded.isClosed(), "出せないフレームを閉じていない");
  assert.isFalse(scheduler.pending);
});

test("handleDecodedFrame: 基準を取り直した後に残ったフレームは表示時刻を決めずに出す", () => {
  // targetLatency を下限にして、表示時刻が未来に残るフレームを積む
  const { timeline, timestampMicros } = makeTimeline(nowMs(), 120);
  const { output, session, scheduler } = makeDefaultSession({ timeline });

  handleWallClockFrame(session, timestampMicros);
  // 基準を取り直す (世代が進む)。積んだときの世代と違うフレームは、新しい基準では表示時刻を
  // 決められないため、届いた順に出す
  timeline.reset();

  scheduler.runNext(nowMs());
  assert.deepEqual(
    output.presented.map((present) => present.timestamp),
    [timestampMicros],
  );
  assert.isNull(output.presented[0]?.presentationMs ?? null);
});

test("handleDecodedFrame: 提示遅延が 1 tick の表示先には 1 tick 前に書く", () => {
  // generator は書き込みの次の vsync で表示される。表示時刻 P のフレームは P - R の tick で
  // 書き込むと、推定表示時刻 P に表示される
  const { timeline, timestampMicros } = makeTimeline(nowMs(), 120);
  const output = makeRecordingOutput(1);
  const { session, scheduler } = makeDefaultSession({ timeline, output });
  handleWallClockFrame(session, timestampMicros);
  const presentationMs = presentationOf(timeline, timestampMicros);
  const refreshMs = 1_000 / 60;

  // 1 tick 前の書き込み tick で書く
  scheduler.runNext(presentationMs - refreshMs);
  assert.deepEqual(
    output.presented.map((present) => present.timestamp),
    [timestampMicros],
  );
  assert.equal(output.presented[0]?.presentationMs, presentationMs);
});

test("handleDecodedFrame: 120 Hz の tick を観測すると表示周期を取り直す", () => {
  const refresh120Ms = 1_000 / 120;
  const observedMs = nowMs() - 10;
  const { timeline, timestampMicros } = makeTimeline(observedMs);
  const output = makeRecordingOutput();
  const { session, scheduler } = makeDefaultSession({ timeline, output });
  handleWallClockFrame(session, timestampMicros);
  const presentationMs = presentationOf(timeline, timestampMicros);

  // 120 Hz の tick を 16 回観測し、表示周期の推定を 8.33 ms にする。フレームの表示時刻から
  // 十分離れた tick だけを使う (まだ描かない)
  // 120 Hz の tick を 16 回観測する。最後の tick と次の検証 tick の間が 66.7 ms を超えると、
  // 外れ値として表示周期を取り直してしまうため、表示時刻の近くまで詰めて観測する
  const warmupStartMs = presentationMs - 140;
  for (let index = 0; index < 16; index++) {
    scheduler.runNext(warmupStartMs + index * refresh120Ms);
  }
  assert.equal(output.presented.length, 0);

  // 表示時刻の 4.2 ms 前の tick では、許容幅 (R / 2 = 4.17 ms) を超えるため描かない
  scheduler.runNext(presentationMs - 4.2);
  assert.equal(output.presented.length, 0, "120 Hz の許容幅を超えて描いた");

  // 次の tick (8.33 ms 後) では、目標が表示時刻の 4.13 ms 後になり、許容幅に入る
  scheduler.runNext(presentationMs - 4.2 + refresh120Ms);
  assert.deepEqual(
    output.presented.map((present) => present.timestamp),
    [timestampMicros],
  );
});

test("handleDecodedFrame: 66.7 ms を超える間隔が空いたら表示周期を 60 Hz に戻す", () => {
  const refresh120Ms = 1_000 / 120;
  const observedMs = nowMs() - 10;
  const { timeline, timestampMicros } = makeTimeline(observedMs);
  const output = makeRecordingOutput();
  const { session, scheduler } = makeDefaultSession({ timeline, output });
  handleWallClockFrame(session, timestampMicros);
  const presentationMs = presentationOf(timeline, timestampMicros);

  // 120 Hz を 16 回観測した後、66.7 ms を超える間隔を空ける
  for (let index = 0; index < 16; index++) {
    scheduler.runNext(presentationMs - 500 + index * refresh120Ms);
  }
  scheduler.runNext(presentationMs - 100);

  // 表示周期は 60 Hz に戻る。表示時刻の 8 ms 前の tick は許容幅 (8.33 ms) に入るため描く
  scheduler.runNext(presentationMs - 8);
  assert.deepEqual(
    output.presented.map((present) => present.timestamp),
    [timestampMicros],
  );
});
