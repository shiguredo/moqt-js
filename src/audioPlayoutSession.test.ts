/**
 * AudioPlayoutSession (共有の音声の再生の組み立て) のテスト
 *
 * `AudioData` と Web Audio は node 環境に実物が無いため、既存の検証と同じく記録用の
 * 最小オブジェクトを注入する (モジュール置換は行わない)。時間軸 (`PlaybackTimeline`) と
 * 計器 (`AudioPlayoutTimingStats`) は実物を使い、共有のロジックとして通しで検証する。
 *
 * ライブラリ (`src/createMediaSubscriber.ts`) と devtools (`devtools/src/hooks/useSubscriber.ts`)
 * が同じ実装を使うため、ここで固定した挙動が両方の基準になる。
 */

import { test, assert } from "vite-plus/test";
import {
  AudioPlayoutSession,
  type AudioPlayoutOutput,
  type AudioPlayoutRequest,
  type AudioPlayoutTimestampKind,
} from "./audioPlayoutSession";
import { AUDIO_PLAYOUT_TIMING_WINDOW_MS, AudioPlayoutTimingStats } from "./audioPlayoutTimingStats";
import type { AudioClockMapping } from "./audioPlayout";
import { AUDIO_PLAYOUT_DELAY_FLOOR_MS, PlaybackTimeline } from "./playbackTimeline";
import { JITTER_BUFFER_MAX_QUEUED_FRAMES } from "./playoutBuffer";

/** 音 1 つ分のサンプル数 (48 kHz の 20 ms) */
const FRAMES_PER_SOUND = 960;
/** サンプルレート (Hz) */
const SAMPLE_RATE = 48_000;
/**
 * `getOutputTimestamp()` が返す音声の出力遅延 (ミリ秒)
 *
 * 実物は数十 ms である。`contextTime * 1_000 - performanceTime` がこの値になる対応を作る
 */
const AUDIO_DEVICE_DELAY_MS = 100;

/**
 * 復号した音を模した最小の `AudioData`
 *
 * `copyTo` は実物と同じくチャンネルごとに呼ばれるため、呼ばれたチャンネルを記録する。
 */
interface RecordedAudioData {
  readonly data: AudioData;
  /** `copyTo` が呼ばれたチャンネルの番号 */
  readonly copiedPlanes: number[];
}

/**
 * 復号した音を作る
 *
 * @param options.timestamp - `AudioData.timestamp` (Unix epoch マイクロ秒)
 * @param options.numberOfFrames - サンプル数。省略時は 20 ms 分
 * @param options.numberOfChannels - チャンネル数
 */
function makeAudioData(
  options: {
    timestamp?: number;
    numberOfFrames?: number;
    numberOfChannels?: number;
  } = {},
): RecordedAudioData {
  const numberOfFrames = options.numberOfFrames ?? FRAMES_PER_SOUND;
  const numberOfChannels = options.numberOfChannels ?? 1;
  const copiedPlanes: number[] = [];
  const data = {
    timestamp: options.timestamp ?? 0,
    numberOfChannels,
    numberOfFrames,
    sampleRate: SAMPLE_RATE,
    copyTo: (_destination: Float32Array, init: { planeIndex: number; format: string }) => {
      copiedPlanes.push(init.planeIndex);
    },
    close: () => {},
  } as unknown as AudioData;
  return { data, copiedPlanes };
}

/** 音を鳴らす先の記録用オブジェクト */
interface RecordedOutput {
  readonly output: AudioPlayoutOutput;
  /** 次に扱う音の timestamp を決める (`getOutputTimestamp()` の中で目標の表示時刻を求める) */
  setTimestamp(timestampMicros: number): void;
  /** `start(when)` に渡った時刻 (秒)。補間の分も含む */
  readonly startedAtSeconds: number[];
  /** `createBuffer` に渡った長さ (サンプル数)。補間の分も含む */
  readonly bufferFrames: number[];
  /** `createBuffer` に渡ったチャンネル数 */
  readonly bufferChannels: number[];
  /** `getOutputTimestamp()` を読んだ時点の目標の表示時刻 (ミリ秒) */
  readonly presentationMs: number;
}

/**
 * 音を鳴らす先を作る
 *
 * @param options.timeline - 目標の表示時刻を求める時間軸 (実装が読むのと同じ時点で測る)
 * @param options.mapping - `getOutputTimestamp()` が返す対応。null なら未開始 (0/0)
 * @param options.currentTimeSeconds - `AudioContext.currentTime` (秒)
 * @param options.failCreateBuffer - `createBuffer` を失敗させるか (失敗した音の検証用)
 * @param options.advanceCurrentTime - `currentTime` を実時間と同じ速さで進めるか。実時間と
 *   同じ間隔で音を渡すテストで必要になる (固定のままだと、目標の時刻が実時間からずれていき、
 *   並べすぎとして捨てられる)
 */
function makeRecordingOutput(options: {
  timeline: PlaybackTimeline;
  mapping: AudioClockMapping | null;
  currentTimeSeconds: number;
  failCreateBuffer?: boolean;
  advanceCurrentTime?: boolean;
}): RecordedOutput {
  const createdAtMs = performance.now();
  const effectiveMapping: AudioClockMapping = options.mapping ?? {
    contextTime: 0,
    performanceTime: 0,
  };
  const startedAtSeconds: number[] = [];
  const bufferFrames: number[] = [];
  const bufferChannels: number[] = [];
  let presentationMs = 0;
  let timestampMicros = 0;
  const output: AudioPlayoutOutput = {
    context: {
      get currentTime() {
        // 記録用の出力は既定では `currentTime` を固定する (1 音だけを確かめるテスト向け)
        return options.advanceCurrentTime === true
          ? options.currentTimeSeconds + (performance.now() - createdAtMs) / 1_000
          : options.currentTimeSeconds;
      },
      getOutputTimestamp: () => {
        // 実装が目標の表示時刻を求めるのと同じ時点で測る (テスト側の値と実装の値がずれない)
        presentationMs = options.timeline.presentationPerformanceMs("audio", timestampMicros) ?? 0;
        return effectiveMapping;
      },
      createBuffer: (numberOfChannels: number, length: number) => {
        if (options.failCreateBuffer === true) {
          throw new Error("createBuffer failed");
        }
        bufferChannels.push(numberOfChannels);
        bufferFrames.push(length);
        return { copyToChannel: () => {} } as unknown as AudioBuffer;
      },
      createBufferSource: () =>
        ({
          buffer: null,
          connect: () => {},
          start: (when: number) => {
            startedAtSeconds.push(when);
          },
        }) as unknown as AudioBufferSourceNode,
    },
    destination: {} as AudioNode,
  };
  return {
    output,
    setTimestamp: (value: number) => {
      timestampMicros = value;
    },
    startedAtSeconds,
    bufferFrames,
    bufferChannels,
    get presentationMs() {
      return presentationMs;
    },
  };
}

/** テストで使う時間軸と計器と共有実装の組 */
interface SessionFixture {
  readonly session: AudioPlayoutSession;
  readonly timeline: PlaybackTimeline;
  readonly timing: AudioPlayoutTimingStats;
}

/** 時間軸と計器と共有実装を作る */
function makeSessionFixture(options: { audioDelayFeedback?: boolean } = {}): SessionFixture {
  const timeline = new PlaybackTimeline({
    timeOriginMs: performance.timeOrigin,
    maxQueuedFrames: JITTER_BUFFER_MAX_QUEUED_FRAMES,
  });
  const timing = new AudioPlayoutTimingStats(
    AUDIO_PLAYOUT_TIMING_WINDOW_MS,
    performance.timeOrigin,
  );
  const session = new AudioPlayoutSession(
    options.audioDelayFeedback === undefined
      ? { timing }
      : { timing, audioDelayFeedback: options.audioDelayFeedback },
  );
  return { session, timeline, timing };
}

/**
 * 共有実装へ音 1 つを渡す
 *
 * 依頼の既定は「時間軸を使い、揃える相手がいる (壁時計の TIMESTAMP)」である。テストごとに
 * 必要な項目だけを上書きする。
 */
function handleSound(
  fixture: SessionFixture,
  output: AudioPlayoutOutput | null,
  options: {
    timestamp?: number;
    numberOfFrames?: number;
    numberOfChannels?: number;
    timestampKind?: AudioPlayoutTimestampKind;
    useTimeline?: boolean;
    enforceTarget?: boolean;
  } = {},
): ReturnType<AudioPlayoutSession["handleDecodedAudio"]> {
  const request: AudioPlayoutRequest = {
    data: makeAudioData({
      ...(options.timestamp === undefined ? {} : { timestamp: options.timestamp }),
      ...(options.numberOfFrames === undefined ? {} : { numberOfFrames: options.numberOfFrames }),
      ...(options.numberOfChannels === undefined
        ? {}
        : { numberOfChannels: options.numberOfChannels }),
    }).data,
    timestampKind: options.timestampKind ?? "wallClock",
    timeline: fixture.timeline,
    useTimeline: options.useTimeline ?? true,
    enforceTarget: options.enforceTarget ?? true,
    output,
  };
  return fixture.session.handleDecodedAudio(request);
}

/** `performance.now()` と同じ軸の観測時刻 (Unix epoch ミリ秒) を今とする */
function observedWallClockMs(): number {
  return performance.timeOrigin + performance.now();
}

/** 音 1 つの長さ (ミリ秒)。opus のパケットと同じ 20 ms である */
const SOUND_INTERVAL_MS = (FRAMES_PER_SOUND / SAMPLE_RATE) * 1_000;

/** 実時間と同じ間隔で音を渡すための待ち */
function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** 今の壁時計 (Unix epoch マイクロ秒) を timestamp にする */
function wallClockTimestampMicros(): number {
  return Math.round(observedWallClockMs() * 1_000);
}

/** 対応と、その対応を基準にした TIMESTAMP を作る (基準の遅れを 0 にする) */
function audioClockMappingAt(referenceMs: number): AudioClockMapping {
  return {
    // 差 (contextTime * 1000 - performanceTime) がそのまま音声の出力遅延になる
    contextTime: referenceMs / 1_000 + AUDIO_DEVICE_DELAY_MS / 1_000,
    performanceTime: referenceMs,
  };
}

/**
 * 完了条件: 鳴らす先が無いとき (音声を再生していないとき) は、時間軸への記録も計器への
 * 記録も行わない。予約もしない (呼び出し側が `AudioData` を閉じる)。
 */
test("handleDecodedAudio: 鳴らす先が無いときは何もしない", () => {
  const fixture = makeSessionFixture();

  const result = handleSound(fixture, null, { timestamp: wallClockTimestampMicros() });

  assert.deepEqual(result, { status: "skipped" });
  const snapshot = fixture.timing.snapshot(performance.now());
  assert.equal(snapshot.playedFrames, 0);
  assert.equal(snapshot.missedFrames, 0);
  // 時間軸へも記録しない (基準が無いままである)
  assert.isNull(fixture.timeline.delayBreakdown.audio.baseDelayMs);
});

/**
 * 完了条件: 壁時計の TIMESTAMP を持つ音は、共有の時間軸へ記録され、時間軸が決めた目標の
 * 表示時刻へ予約される。鳴り始める時刻と到着時刻は計器へ記録される。
 */
test("handleDecodedAudio: 壁時計の TIMESTAMP の音を目標の時刻へ予約する", () => {
  const fixture = makeSessionFixture();
  const referenceMs = performance.now();
  const mapping = audioClockMappingAt(referenceMs);
  const timestamp = wallClockTimestampMicros();
  const output = makeRecordingOutput({
    timeline: fixture.timeline,
    mapping,
    currentTimeSeconds: referenceMs / 1_000,
  });
  output.setTimestamp(timestamp);

  const result = handleSound(fixture, output.output, { timestamp });

  assert.equal(result.status, "played");
  assert.equal(result.status === "played" && result.rebased, false, "基準を取り直さないこと");
  assert.equal(output.startedAtSeconds.length, 1, "音を 1 つ予約すること");
  // 予約時刻は「目標の表示時刻 + 音声の出力遅延」を AudioContext の秒にした値になる
  assert.closeTo(
    (output.startedAtSeconds[0] ?? 0) * 1_000,
    output.presentationMs + AUDIO_DEVICE_DELAY_MS,
    50,
    "目標の表示時刻へ予約すること",
  );
  // 時間軸へ記録されている (表示時刻を決められる)
  assert.isAbove(fixture.timeline.delayBreakdown.audio.baseDelayMs ?? Number.NaN, 0);
  // 復号した音は、実際に作ったバッファへチャンネルごとにコピーする
  assert.equal(output.bufferChannels.length, 1);
  assert.deepEqual(output.bufferChannels, [1]);

  const snapshot = fixture.timing.snapshot(performance.now());
  assert.equal(snapshot.playedFrames, 1);
  assert.closeTo(snapshot.playedMs, (FRAMES_PER_SOUND / SAMPLE_RATE) * 1_000, 1e-6);
  assert.equal(snapshot.unplannedFrames, 0, "時間軸の計画で鳴らした音であること");
  assert.equal(snapshot.missedFrames, 0);
  assert.isNotNull(snapshot.lastTargetMs, "LOC TIMESTAMP から目標の時刻を決めること");
  assert.closeTo(
    snapshot.lastStartMs ?? 0,
    (output.startedAtSeconds[0] ?? 0) * 1_000 - AUDIO_DEVICE_DELAY_MS,
    1e-6,
    "鳴り始める時刻は予約した時刻を performance 軸へ換算した値であること",
  );
  assert.closeTo(
    snapshot.lastStartDelayMs ?? 0,
    (snapshot.lastStartMs ?? 0) - snapshot.lastArrivalMs!,
    1e-6,
  );
});

/**
 * 完了条件: 壁時計の TIMESTAMP を持たない音 (TIMESTAMP 無し、Timescale ありのメディア時刻) は
 * 時間軸へ記録せず、到着基準で並べる。目標の時刻も持たない。
 */
test("handleDecodedAudio: 壁時計でない TIMESTAMP は到着基準で並べる", () => {
  for (const timestampKind of ["none", "mediaTime"] as const) {
    const fixture = makeSessionFixture();
    const output = makeRecordingOutput({
      timeline: fixture.timeline,
      mapping: null,
      currentTimeSeconds: 10,
    });

    const result = handleSound(fixture, output.output, {
      timestamp: 20_000,
      timestampKind,
    });

    assert.equal(result.status, "played", `${timestampKind}: 鳴らすこと`);
    assert.equal(
      fixture.timeline.delayBreakdown.audio.baseDelayMs,
      null,
      `${timestampKind}: 時間軸へ記録しないこと`,
    );
    const snapshot = fixture.timing.snapshot(performance.now());
    assert.equal(
      snapshot.arrivalPlannedFrames,
      1,
      `${timestampKind}: 到着基準の計画で鳴らした音として数えること`,
    );
    assert.isNull(snapshot.lastTargetMs, `${timestampKind}: 目標の時刻を持たないこと`);
    // 到着 (今) から再生の遅れだけ後ろに予約する
    assert.isAbove(output.startedAtSeconds[0] ?? 0, 10);
    assert.isAtMost(
      (output.startedAtSeconds[0] ?? 0) * 1_000,
      10_000 + AUDIO_PLAYOUT_DELAY_FLOOR_MS + 50,
      `${timestampKind}: 到着から再生の遅れの範囲で鳴らすこと`,
    );
  }
});

/**
 * 完了条件: 時間軸を使わないとき (jitter buffer が無効な購読) は、壁時計の TIMESTAMP を
 * 持っていても時間軸へ記録せず、到着基準で並べる。時間軸へ記録すると映像とずれる。
 */
test("handleDecodedAudio: 時間軸を使わないときは壁時計でも到着基準にする", () => {
  const fixture = makeSessionFixture();
  const output = makeRecordingOutput({
    timeline: fixture.timeline,
    mapping: null,
    currentTimeSeconds: 10,
  });

  const result = handleSound(fixture, output.output, { timestamp: 20_000, useTimeline: false });

  assert.equal(result.status, "played");
  assert.isNull(fixture.timeline.delayBreakdown.audio.baseDelayMs, "時間軸へ記録しないこと");
  const snapshot = fixture.timing.snapshot(performance.now());
  assert.equal(snapshot.arrivalPlannedFrames, 1);
  assert.isNull(snapshot.lastTargetMs);
});

/**
 * 完了条件: 並べすぎで捨てた音は、理由と長さと一緒に計器へ記録し、結果でも捨てたと返す。
 *
 * 1 つ目の音を 1 秒ぶん予約したあと (前の音の終わりが 1 秒先)、さらに timestamp が 2 秒
 * 飛んだ音が届くと、前の音の終わりより前へは並べられないため捨てる
 * (src/audioPlayout.ts の scheduleByArrival)。
 */
test("handleDecodedAudio: 並べすぎの音は捨てて計器へ記録する", () => {
  const fixture = makeSessionFixture();
  const first = makeRecordingOutput({
    timeline: fixture.timeline,
    mapping: null,
    currentTimeSeconds: 10,
  });
  assert.equal(
    handleSound(fixture, first.output, {
      timestamp: 0,
      numberOfFrames: SAMPLE_RATE,
      timestampKind: "none",
    }).status,
    "played",
  );

  const second = makeRecordingOutput({
    timeline: fixture.timeline,
    mapping: null,
    currentTimeSeconds: 10,
  });
  const result = handleSound(fixture, second.output, {
    timestamp: 2_000_000,
    timestampKind: "none",
  });

  assert.equal(result.status, "dropped");
  assert.equal(result.status === "dropped" && result.reason, "backlog");
  assert.equal(result.status === "dropped" && result.rebased, false);
  assert.equal(second.startedAtSeconds.length, 0, "捨てた音は予約しないこと");
  const snapshot = fixture.timing.snapshot(performance.now());
  assert.equal(snapshot.playedFrames, 1, "捨てた音は鳴った音として数えないこと");
  assert.equal(snapshot.missedByReason.backlog.count, 1);
  assert.closeTo(snapshot.missedByReason.backlog.ms, 20, 1e-6);
  assert.equal(snapshot.missedFrames, 1);
});

/**
 * 完了条件: 鳴らす準備の途中で失敗した音は、鳴らなかった音として計器へ記録し、失敗は
 * 結果として呼び出し側へ返す (このクラスは throw しない)。
 */
test("handleDecodedAudio: 鳴らす準備の失敗は計器へ記録して結果で返す", () => {
  const fixture = makeSessionFixture();
  const output = makeRecordingOutput({
    timeline: fixture.timeline,
    mapping: null,
    currentTimeSeconds: 10,
    failCreateBuffer: true,
  });

  const result = handleSound(fixture, output.output, { timestamp: 0, timestampKind: "none" });

  assert.equal(result.status, "error");
  assert.equal(result.status === "error" && result.error.message, "createBuffer failed");
  assert.equal(result.status === "error" && result.rebased, false);
  const snapshot = fixture.timing.snapshot(performance.now());
  assert.equal(snapshot.playedFrames, 0);
  assert.equal(snapshot.missedByReason.error.count, 1);
  assert.closeTo(snapshot.missedByReason.error.ms, 20, 1e-6);
});

/**
 * 完了条件: 音が抜けた分の隙間は、直前の音の末尾を伸ばして予約する (無音のまま残さない)。
 * 直前の音は、次の音の補間のために保持される。
 */
test("handleDecodedAudio: 欠落した区間を直前の音の末尾で補間する", () => {
  const fixture = makeSessionFixture();
  const first = makeRecordingOutput({
    timeline: fixture.timeline,
    mapping: null,
    currentTimeSeconds: 10,
  });
  assert.equal(
    handleSound(fixture, first.output, { timestamp: 0, timestampKind: "none" }).status,
    "played",
  );
  assert.equal(first.bufferFrames.length, 1, "最初の音だけを予約すること");

  // 20 ms の音が 1 つ抜けた 40 ms 後の timestamp が届く (40 ms の隙間ではなく 20 ms の隙間)
  const second = makeRecordingOutput({
    timeline: fixture.timeline,
    mapping: null,
    currentTimeSeconds: 10.02,
  });
  const result = handleSound(fixture, second.output, { timestamp: 40_000, timestampKind: "none" });

  assert.equal(result.status, "played");
  // 1 つ目は隙間の補間 (960 サンプル)、2 つ目は届いた音である
  assert.deepEqual(second.bufferFrames, [FRAMES_PER_SOUND, FRAMES_PER_SOUND]);
  assert.equal(second.startedAtSeconds.length, 2);
  assert.equal(fixture.session.playout.concealments, 1);
  assert.closeTo(fixture.session.playout.concealed * 1_000, 20, 1e-6);
});

/**
 * 完了条件: この音の予約で基準を取り直したかを、結果で呼び出し側へ返す (devtools が
 * `audioPlayoutRebases` として数える)。取り直しは、鳴らす時刻を過ぎて届いた音で起きる。
 */
test("handleDecodedAudio: 基準を取り直したかを結果で返す", () => {
  const fixture = makeSessionFixture();
  const first = makeRecordingOutput({
    timeline: fixture.timeline,
    mapping: null,
    currentTimeSeconds: 100,
  });
  const firstResult = handleSound(fixture, first.output, { timestamp: 0 });
  assert.equal(firstResult.status === "played" && firstResult.rebased, false);

  // 鳴らす時刻 (100.08) を大きく過ぎた 200 秒の位置へ、timestamp の飛んだ音が届く
  const second = makeRecordingOutput({
    timeline: fixture.timeline,
    mapping: null,
    currentTimeSeconds: 200,
  });
  const secondResult = handleSound(fixture, second.output, { timestamp: 20_000 });

  assert.equal(secondResult.status, "played");
  assert.equal(secondResult.status === "played" && secondResult.rebased, true);
  assert.equal(fixture.session.playout.rebases, 1);
});

/**
 * 完了条件: 鳴らした結果 (予定をどれだけ過ぎたか) を閉ループ (音声の目標遅延の学習) へ
 * 渡すかどうかを、呼び出し側が選べる。既定はライブラリと同じ「渡す」である。
 */
test("handleDecodedAudio: 閉ループへ渡すかどうかを選べる", () => {
  const withFeedback = makeSessionFixture();
  const first = makeRecordingOutput({
    timeline: withFeedback.timeline,
    mapping: null,
    currentTimeSeconds: 10,
  });
  assert.equal(handleSound(withFeedback, first.output, { timestamp: 0 }).status, "played");
  // 観測が 1 つ届いている (予定を過ぎた量と到着から鳴るまでの分布が残る)
  assert.isNotNull(
    withFeedback.timeline.delayBreakdown.audioDelayFeedback.startDelayP50Ms,
    "既定では閉ループへ渡すこと",
  );

  const withoutFeedback = makeSessionFixture({ audioDelayFeedback: false });
  const second = makeRecordingOutput({
    timeline: withoutFeedback.timeline,
    mapping: null,
    currentTimeSeconds: 10,
  });
  assert.equal(handleSound(withoutFeedback, second.output, { timestamp: 0 }).status, "played");
  // 閉ループへ渡さないため、初期状態のままである
  assert.isNull(withoutFeedback.timeline.delayBreakdown.audioDelayFeedback.startDelayP50Ms);
  assert.equal(withoutFeedback.timeline.delayBreakdown.audioDelayFeedback.reason, "initial");
  // 計器への記録は、閉ループへ渡さないときも行う
  assert.equal(withoutFeedback.timing.snapshot(performance.now()).playedFrames, 1);
});

/**
 * 完了条件: `reset` は予約の基準・時計の対応・直前の音を消す (AudioContext を作り直した
 * とき)。消したあとの音は、新しい基準で並べ直す。
 */
test("reset: 予約の基準と時計の対応と直前の音を消す", () => {
  const fixture = makeSessionFixture();
  const referenceMs = performance.now();
  const mapping = audioClockMappingAt(referenceMs);
  const timestamp = wallClockTimestampMicros();
  const output = makeRecordingOutput({
    timeline: fixture.timeline,
    mapping,
    currentTimeSeconds: referenceMs / 1_000,
  });
  output.setTimestamp(timestamp);
  assert.equal(handleSound(fixture, output.output, { timestamp }).status, "played");
  assert.isNotNull(fixture.session.clock.currentOffsetMs);

  fixture.session.reset();

  assert.isNull(fixture.session.clock.currentOffsetMs, "時計の対応を消すこと");
  assert.equal(fixture.session.playout.lateness, 0, "予約の基準を消すこと");
  // 直前の音も消すため、次の音で補間を作らない
  const next = makeRecordingOutput({
    timeline: fixture.timeline,
    mapping: null,
    currentTimeSeconds: 10.02,
  });
  assert.equal(
    handleSound(fixture, next.output, { timestamp: 40_000, timestampKind: "none" }).status,
    "played",
  );
  assert.deepEqual(next.bufferFrames, [FRAMES_PER_SOUND], "補間を作らないこと");
});

/**
 * 完了条件: `releaseAudioContext` は AudioContext を閉じた後始末として時計の対応と直前の
 * 音を消すが、予約の基準 (統計の `playoutLatenessMs` が読む値) は残す。
 */
test("releaseAudioContext: 時計の対応だけを消し、予約の基準は残す", () => {
  const fixture = makeSessionFixture();
  const referenceMs = performance.now();
  const mapping = audioClockMappingAt(referenceMs);
  const output = makeRecordingOutput({
    timeline: fixture.timeline,
    mapping,
    currentTimeSeconds: referenceMs / 1_000,
  });
  output.setTimestamp(wallClockTimestampMicros());
  assert.equal(handleSound(fixture, output.output, { timestamp: 0 }).status, "played");
  // 予定を過ぎて鳴った音を作る (遅れを持たせる)
  const decision = fixture.session.playout.schedule(10, 0, 0.02, {
    targetStartSeconds: 10,
    arrivalSeconds: 10,
    enforceTarget: true,
    delaySeconds: 0.08,
    arrivalDelaySeconds: 0.08,
    presentationDelaySeconds: 0.08,
  });
  assert.equal(decision.kind, "play");
  if (decision.kind !== "play") {
    return;
  }
  fixture.session.playout.confirmStretch(decision.compressSeconds);
  assert.isAbove(fixture.session.playout.lateness, 0);

  fixture.session.releaseAudioContext();

  assert.isNull(fixture.session.clock.currentOffsetMs, "時計の対応を消すこと");
  assert.isAbove(fixture.session.playout.lateness, 0, "予約の基準は残すこと");
});

/**
 * 完了条件: `recordStopped` は、予約済みでまだ鳴り始めていない音を鳴らなかった分として
 * 計器へ記録する (AudioContext を閉じる直前に呼ぶ)。
 */
test("recordStopped: 予約済みで鳴らなかった分を計器へ記録する", () => {
  const fixture = makeSessionFixture();
  const output = makeRecordingOutput({
    timeline: fixture.timeline,
    mapping: null,
    currentTimeSeconds: 10,
  });
  assert.equal(handleSound(fixture, output.output, { timestamp: 0 }).status, "played");
  assert.equal(fixture.timing.snapshot(performance.now()).missedFrames, 0, "まだ鳴っている");

  fixture.session.recordStopped();

  const snapshot = fixture.timing.snapshot(performance.now());
  assert.equal(snapshot.missedByReason.stopped.count, 1);
  assert.closeTo(snapshot.missedByReason.stopped.ms, 20, 1e-6);
  assert.equal(snapshot.missedFrames, 1);
});

/**
 * 完了条件: 復号の出力が送られた TIMESTAMP から遅れ続けたら、受信側の追いつきを始めて
 * 復号器の作り直しを求める (結果の `catchUpStarted`)。鳴らす音は捨てない (追いつきは
 * 復号器を作り直すことで行うため、`missedFrames` を増やさない)。
 *
 * 遅れの段差は、実リレーの E2E の失敗 (音声の基準の遅れが 116.4 ms から 256.2 ms へ
 * 上がり、そのまま戻らなかった) と同じ形にする。音は 1 つ 20 ms であり、実時間と同じ間隔で
 * 渡す (まとめて渡すと、鳴らす側が並べすぎとして捨てる)。持続の確認 (`100 ms`) は実時間で
 * 測るため、遅れを上げた後はその時間だけ実際に待つ。
 */
test("handleDecodedAudio: 遅れが続いたら復号器の作り直しを求める", async () => {
  const fixture = makeSessionFixture();
  const referenceMs = performance.now();
  const mapping = audioClockMappingAt(referenceMs);
  const output = makeRecordingOutput({
    timeline: fixture.timeline,
    mapping,
    currentTimeSeconds: referenceMs / 1_000,
    advanceCurrentTime: true,
  });

  // 健全な遅れ (20 ms) の音を 100 ms 分鳴らす。床は 20 ms になり、上限は下限の 60 ms になる
  for (let index = 0; index < 5; index++) {
    const result = handleSound(fixture, output.output, {
      timestamp: wallClockTimestampMicros() - 20_000,
    });
    assert.equal(result.status, "played");
    assert.equal(
      result.status === "skipped" ? undefined : result.catchUpStarted,
      false,
      "健全な状態では始めないこと",
    );
    await sleepMs(SOUND_INTERVAL_MS);
  }

  // 遅れを段差で 200 ms へ上げ、持続の確認 (100 ms) より長く続ける。確認は実時間で測るため、
  // 環境が混んでいても確認が終わるよう、始まるまで (上限 1 秒) 続ける
  const results: ReturnType<AudioPlayoutSession["handleDecodedAudio"]>[] = [];
  const deadlineMs = performance.now() + 1_000;
  while (performance.now() < deadlineMs) {
    const result = handleSound(fixture, output.output, {
      timestamp: wallClockTimestampMicros() - 200_000,
    });
    results.push(result);
    if (result.status === "played" && result.catchUpStarted) {
      break;
    }
    await sleepMs(SOUND_INTERVAL_MS);
  }

  const started = results.find((result) => result.status === "played" && result.catchUpStarted);
  assert.isDefined(started, "遅れが続いたら復号器の作り直しを求めること");
  assert.equal(started?.status === "played" && started.catchUpStarted, true);
  const snapshot = fixture.session.catchUp.snapshot();
  assert.equal(snapshot.catchUpStarts, 1);
  assert.equal(snapshot.catchingUp, true, "遅れが上限へ戻るまで追いつきの最中であること");
  assert.closeTo(snapshot.lagMs ?? 0, 200, 20, "観測した遅れ");
  assert.closeTo(snapshot.floorMs ?? 0, 20, 5, "床は健全時に観測した遅れであること");
  assert.closeTo(snapshot.limitMs, 60, 5, "上限は下限 (60 ms) であること");
  // 鳴らす音は捨てない
  assert.equal(fixture.timing.snapshot(performance.now()).missedFrames, 0);
  assert.equal(
    results.filter((result) => result.status === "dropped").length,
    0,
    "追いつきで鳴らさずに捨てないこと",
  );
});

/**
 * 完了条件: 壁時計の TIMESTAMP を持たない音 (TIMESTAMP 無し、Timescale ありのメディア時刻)
 * では追いつきを判定しない。復号の出力と壁時計を対応づけられないためである。
 */
test("handleDecodedAudio: 壁時計でない TIMESTAMP では追いつきを判定しない", () => {
  const fixture = makeSessionFixture();
  const output = makeRecordingOutput({
    timeline: fixture.timeline,
    mapping: null,
    currentTimeSeconds: 10,
  });

  for (let index = 0; index < 10; index++) {
    const result = handleSound(fixture, output.output, {
      timestamp: 1_000_000 - index * 20_000,
      timestampKind: "mediaTime",
    });
    assert.equal(result.status, "played");
    assert.equal(
      result.status === "skipped" ? undefined : result.catchUpStarted,
      false,
      "追いつきを始めないこと",
    );
  }
  assert.isNull(fixture.session.catchUp.snapshot().lagMs, "遅れを観測しないこと");
  assert.equal(fixture.session.catchUp.snapshot().catchUpStarts, 0);
});

/**
 * 完了条件: 鳴らす先が無いとき (音声を再生していないとき) は、追いつきの観測もしない。
 */
test("handleDecodedAudio: 鳴らす先が無いときは追いつきを観測しない", () => {
  const fixture = makeSessionFixture();

  const result = handleSound(fixture, null, { timestamp: 0 });

  assert.deepEqual(result, { status: "skipped" });
  assert.isNull(fixture.session.catchUp.snapshot().lagMs);
  assert.equal(fixture.session.catchUp.snapshot().catchUpStarts, 0);
});

/**
 * 完了条件: `reset` は受信側の追いつきの観測も消す (AudioContext を作り直したとき)。
 * 消さないと、前の購読の遅れ (床) を引き継いで誤って追いつきを始める。
 */
test("reset: 受信側の追いつきの観測も消す", () => {
  const fixture = makeSessionFixture();
  const output = makeRecordingOutput({
    timeline: fixture.timeline,
    mapping: null,
    currentTimeSeconds: 10,
  });
  assert.equal(
    handleSound(fixture, output.output, { timestamp: wallClockTimestampMicros() - 500_000 }).status,
    "played",
  );
  assert.closeTo(fixture.session.catchUp.snapshot().lagMs ?? 0, 500, 50);

  fixture.session.reset();

  const snapshot = fixture.session.catchUp.snapshot();
  assert.isNull(snapshot.lagMs);
  assert.isNull(snapshot.floorMs);
  assert.equal(snapshot.catchUpStarts, 0);
  assert.equal(snapshot.catchingUp, false);
});
