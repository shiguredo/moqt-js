/**
 * AudioPlayoutSession (共有の音声の再生の組み立て) のテスト
 *
 * `AudioData` と Web Audio は node 環境に実物が無いため、既存の検証と同じく記録用の
 * 最小オブジェクトを注入する (モジュール置換は行わない)。時間軸 (`PlayoutTimeline`) と
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
import { AUDIO_PLAYOUT_DELAY_FLOOR_MS, MAX_PLAYOUT_DELAY_MS, PlayoutTimeline } from "./timeline";
import { JITTER_BUFFER_MAX_QUEUED_FRAMES } from "./buffer";
import { AUDIO_RECEIVE_CATCH_UP_MIN_MS } from "./audioReceiveCatchUp";
import { AUDIO_DELAY_FEEDBACK_INTERVAL_MS } from "./audioDelayFeedback";

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
 * @param options.sampleRate - サンプルレート (Hz)。省略時は 48 kHz
 * @param options.samples - チャンネルごとの実サンプル。省略時は無音 (0)
 */
function makeAudioData(
  options: {
    timestamp?: number;
    numberOfFrames?: number;
    numberOfChannels?: number;
    sampleRate?: number;
    samples?: readonly Float32Array[];
  } = {},
): RecordedAudioData {
  const numberOfFrames = options.numberOfFrames ?? FRAMES_PER_SOUND;
  const numberOfChannels = options.numberOfChannels ?? 1;
  const copiedPlanes: number[] = [];
  const data = {
    timestamp: options.timestamp ?? 0,
    numberOfChannels,
    numberOfFrames,
    sampleRate: options.sampleRate ?? SAMPLE_RATE,
    copyTo: (destination: Float32Array, init: { planeIndex: number; format: string }) => {
      copiedPlanes.push(init.planeIndex);
      // 本番の AudioData.copyTo と同じく、チャンネルごとのサンプルを書き込む
      const samples = options.samples?.[init.planeIndex];
      if (samples !== undefined) {
        destination.set(samples.subarray(0, Math.min(destination.length, samples.length)));
      }
    },
    close: () => {},
  } as unknown as AudioData;
  return { data, copiedPlanes };
}

/** 一定振幅のサンプル列を作る (境界の段差を測るため、末尾と先頭が 0 でない値になる) */
function constantSamples(amplitude: number, frames = FRAMES_PER_SOUND): Float32Array {
  const samples = new Float32Array(frames);
  samples.fill(amplitude);
  return samples;
}

/** 連続した 440 Hz の正弦のサンプル列 (frameIndex 番目の 20 ms) を作る */
function toneSamples(frameIndex: number, amplitude = 0.2): Float32Array {
  const samples = new Float32Array(FRAMES_PER_SOUND);
  for (let index = 0; index < FRAMES_PER_SOUND; index++) {
    const position = frameIndex * FRAMES_PER_SOUND + index;
    samples[index] = amplitude * Math.sin(2 * Math.PI * 440 * (position / SAMPLE_RATE));
  }
  return samples;
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
  /** 予約したバッファの内容 (予約順)。補間の分も含む */
  readonly recordedBuffers: {
    whenSeconds: number;
    sampleRate: number;
    channels: Float32Array[];
    /** `start()` を呼んだ時点の `currentTime` (秒) */
    currentTimeAtStart: number;
  }[];
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
 * @param options.createBufferWorkMs - `createBuffer` のたびに `currentTime` を進める長さ
 *   (ミリ秒)。予約の判断から `start()` までのメインスレッドの停止を模す
 * @param options.advanceOnTimestampMs - `getOutputTimestamp()` を読むたびに `currentTime` を
 *   進める長さ (ミリ秒)。音の到着の間隔を実時間で待たずに作る
 * @param options.mappingFromCurrentTime - `getOutputTimestamp()` に、その時点の
 *   `currentTime` と同じ位置を返させるか。到着した音がまだ鳴っていない位置を
 *   `currentTime` に一致させる (到着基準の並べ方を決定的にする)
 */
function makeRecordingOutput(options: {
  timeline: PlayoutTimeline;
  mapping: AudioClockMapping | null;
  currentTimeSeconds: number;
  failCreateBuffer?: boolean;
  advanceCurrentTime?: boolean;
  createBufferWorkMs?: number;
  advanceOnTimestampMs?: number;
  mappingFromCurrentTime?: boolean;
}): RecordedOutput {
  const createdAtMs = performance.now();
  const effectiveMapping: AudioClockMapping = options.mapping ?? {
    contextTime: 0,
    performanceTime: 0,
  };
  const startedAtSeconds: number[] = [];
  const bufferFrames: number[] = [];
  const bufferChannels: number[] = [];
  const recordedBuffers: RecordedOutput["recordedBuffers"] = [];
  let presentationMs = 0;
  let timestampMicros = 0;
  // createBuffer で進めた作業時間 (ミリ秒)。予約判断の後に currentTime が進む
  let workMs = 0;
  // getOutputTimestamp() を読むたびに進める時間 (ミリ秒)。到着の間隔を作る
  let timestampAdvanceMs = 0;
  const output: AudioPlayoutOutput = {
    context: {
      get currentTime() {
        // 記録用の出力は既定では `currentTime` を固定する (1 音だけを確かめるテスト向け)
        const elapsedSeconds =
          options.advanceCurrentTime === true ? (performance.now() - createdAtMs) / 1_000 : 0;
        return options.currentTimeSeconds + elapsedSeconds + (workMs + timestampAdvanceMs) / 1_000;
      },
      getOutputTimestamp: () => {
        // 実装が目標の表示時刻を求めるのと同じ時点で測る (テスト側の値と実装の値がずれない)
        presentationMs = options.timeline.presentationPerformanceMs("audio", timestampMicros) ?? 0;
        // 到着の間隔を作るため、対応を読むたびに時計を進める
        timestampAdvanceMs += options.advanceOnTimestampMs ?? 0;
        if (options.mappingFromCurrentTime === true) {
          return {
            contextTime: options.currentTimeSeconds + (workMs + timestampAdvanceMs) / 1_000,
            performanceTime: performance.now(),
          };
        }
        return effectiveMapping;
      },
      createBuffer: (numberOfChannels: number, length: number) => {
        if (options.failCreateBuffer === true) {
          throw new Error("createBuffer failed");
        }
        bufferChannels.push(numberOfChannels);
        bufferFrames.push(length);
        // メインスレッドの停止を模して時計を進める
        workMs += options.createBufferWorkMs ?? 0;
        const channels: Float32Array[] = [];
        for (let channel = 0; channel < numberOfChannels; channel++) {
          channels.push(new Float32Array(length));
        }
        return {
          copyToChannel: (samples: Float32Array, channel: number) => {
            channels[channel]?.set(samples.subarray(0, length));
          },
          __channels: channels,
          sampleRate: SAMPLE_RATE,
        } as unknown as AudioBuffer;
      },
      createBufferSource: () => {
        const source = {
          buffer: null as AudioBuffer | null,
          connect: () => {},
          start: (when: number) => {
            startedAtSeconds.push(when);
            const buffer = source.buffer as unknown as {
              __channels: Float32Array[];
              sampleRate: number;
            } | null;
            if (buffer !== null) {
              recordedBuffers.push({
                whenSeconds: when,
                sampleRate: buffer.sampleRate,
                channels: buffer.__channels,
                currentTimeAtStart:
                  options.currentTimeSeconds + (workMs + timestampAdvanceMs) / 1_000,
              });
            }
          },
        };
        return source as unknown as AudioBufferSourceNode;
      },
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
    recordedBuffers,
    get presentationMs() {
      return presentationMs;
    },
  };
}

/** テストで使う時間軸と計器と共有実装の組 */
interface SessionFixture {
  readonly session: AudioPlayoutSession;
  readonly timeline: PlayoutTimeline;
  readonly timing: AudioPlayoutTimingStats;
}

/** 時間軸と計器と共有実装を作る */
function makeSessionFixture(): SessionFixture {
  const timeline = new PlayoutTimeline({
    timeOriginMs: performance.timeOrigin,
    maxQueuedFrames: JITTER_BUFFER_MAX_QUEUED_FRAMES,
  });
  const timing = new AudioPlayoutTimingStats(
    AUDIO_PLAYOUT_TIMING_WINDOW_MS,
    performance.timeOrigin,
  );
  const session = new AudioPlayoutSession({ timing });
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
    inputLagMs?: number | null;
    intentionalDelayMs?: number;
    sampleRate?: number;
    samples?: readonly Float32Array[];
  } = {},
): ReturnType<AudioPlayoutSession["handleDecodedAudio"]> {
  const request: AudioPlayoutRequest = {
    data: makeAudioData({
      ...(options.timestamp === undefined ? {} : { timestamp: options.timestamp }),
      ...(options.numberOfFrames === undefined ? {} : { numberOfFrames: options.numberOfFrames }),
      ...(options.numberOfChannels === undefined
        ? {}
        : { numberOfChannels: options.numberOfChannels }),
      ...(options.sampleRate === undefined ? {} : { sampleRate: options.sampleRate }),
      ...(options.samples === undefined ? {} : { samples: options.samples }),
    }).data,
    timestampKind: options.timestampKind ?? "wallClock",
    ...(options.inputLagMs === undefined ? {} : { inputLagMs: options.inputLagMs }),
    ...(options.intentionalDelayMs === undefined
      ? {}
      : { intentionalDelayMs: options.intentionalDelayMs }),
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
 * 完了条件: 基準を共有できず到着基準で鳴らした音 (保持されている側) は、時間軸へ実績を
 * 記録しない。
 *
 * 記録するのは、目標の表示時刻を決めて鳴らした音だけである。同期ずれの推定 (`skewMs`) は
 * 2 つのトラックの実績がそろっているときだけ値を返すため、到着基準の再生の値を混ぜると、
 * 制御されていない再生のずれを同期のずれとして読むことになる。映像側は同じ理由で、表示
 * 時刻を決めていないフレームの実績を作らない (src/playout/videoPlayoutSession.ts)。
 *
 * 音声が保持される側になる状態は、音声の基準を映像より大きくしたうえで、表示の遅れの上限を
 * 下げて共有を解除して作る。上限を戻しても、閾値が動いた解除であるため保持は続く。
 */
test("handleDecodedAudio: 保持されている (到着基準の) 音は実績を記録しない", () => {
  const fixture = makeSessionFixture();
  const nowMs = observedWallClockMs();
  // 音声の基準を 400 ms、映像を 100 ms にして、解除したときに音声が保持される側にする
  const observedTimestamp = Math.round(nowMs * 1_000);
  fixture.timeline.observe("audio", nowMs, observedTimestamp - 400_000);
  fixture.timeline.observe("video", nowMs, observedTimestamp - 100_000);
  assert.isTrue(
    fixture.timeline.sharingBases,
    "基準と表示の遅れの観測がそろっていること (差が閾値の内側なら共有すること)",
  );
  fixture.timeline.setTargetLatencyMs(MAX_PLAYOUT_DELAY_MS - 50);
  fixture.timeline.setTargetLatencyMs(null);
  assert.equal(fixture.timeline.delayBreakdown.unsharedReason, "hold", "解除を保持していること");
  assert.isNull(
    fixture.timeline.delayBreakdown.audio.presentationDelayMs,
    "保持している側の表示時刻は決まらないこと",
  );

  // 鳴らす音の TIMESTAMP も 200 ms 前にする。音を渡すと時間軸へ観測が入るため、到着と
  // TIMESTAMP の差を映像 (100 ms) より大きく保ち、保持される側を音声のままにする
  const soundTimestamp = Math.round((nowMs - 200) * 1_000);
  const referenceMs = performance.now();
  const output = makeRecordingOutput({
    timeline: fixture.timeline,
    mapping: audioClockMappingAt(referenceMs),
    currentTimeSeconds: referenceMs / 1_000,
  });
  output.setTimestamp(soundTimestamp);
  assert.isNull(
    fixture.timeline.presentationPerformanceMs("audio", soundTimestamp),
    "目標の表示時刻を引けないこと",
  );

  const result = handleSound(fixture, output.output, { timestamp: soundTimestamp });

  assert.equal(result.status, "played", "到着基準で鳴らすこと");
  // 映像の実績だけを作る。音声の実績を作っていれば推定が出るため、出ないことで「記録して
  // いない」ことを確かめる
  fixture.timeline.recordPresentation(
    "video",
    soundTimestamp,
    BigInt(Math.round((performance.timeOrigin + performance.now()) * 1_000)),
  );
  assert.isNull(fixture.timeline.skewMs(), "保持されている側の実績を作らないこと");
});

/**
 * 完了条件: 並べすぎで捨てた音は、理由と長さと一緒に計器へ記録し、結果でも捨てたと返す。
 *
 * 1 つ目の音を 1 秒ぶん予約したあと (前の音の終わりが 1 秒先)、さらに timestamp が 2 秒
 * 飛んだ音が届くと、前の音の終わりより前へは並べられないため捨てる
 * (src/playout/audioPlayout.ts の scheduleByArrival)。
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
 * 常に渡す。渡さないと目標が実際の到着に合わず、時間圧縮が止まらなくなる (実測がある。
 * `src/playout/audioPlayoutSession.ts` の `observeDelayFeedback`)。計器への記録も行う。
 */
test("handleDecodedAudio: 鳴らした結果を閉ループへ渡し、計器にも記録する", () => {
  const fixture = makeSessionFixture();
  const output = makeRecordingOutput({
    timeline: fixture.timeline,
    mapping: null,
    currentTimeSeconds: 10,
  });
  assert.equal(handleSound(fixture, output.output, { timestamp: 0 }).status, "played");
  // 観測が届いている (予定を過ぎた量と到着から鳴るまでの分布が残る)
  assert.isNotNull(
    fixture.timeline.delayBreakdown.audioDelayFeedback.startDelayP50Ms,
    "閉ループへ渡すこと",
  );
  // 計器にも記録されている
  assert.equal(fixture.timing.snapshot(performance.now()).playedFrames, 1, "計器に記録すること");
});

/**
 * 完了条件: 時間圧縮と補間を使えないサンプルレート (4 kHz へ間引くフィルタの表に無い
 * 44.1 kHz など) では、そのことを計器に数える。落ちずに「操作しない」を返すため、
 * 数えないと遅れが目標へ戻らない原因を追えない
 */
test("handleDecodedAudio: 時間圧縮を使えないサンプルレートを計器に数える", () => {
  const fixture = makeSessionFixture();
  const output = makeRecordingOutput({
    timeline: fixture.timeline,
    mapping: null,
    currentTimeSeconds: 10,
  });
  // 48 kHz では数えない
  assert.equal(handleSound(fixture, output.output, { timestamp: 0 }).status, "played");
  assert.equal(
    fixture.timing.snapshot(performance.now()).stretchUnavailableFrames,
    0,
    "48 kHz では数えないこと",
  );
  // 44.1 kHz (対応表に無い) では数える
  assert.equal(
    handleSound(fixture, output.output, { timestamp: 20_000, sampleRate: 44_100 }).status,
    "played",
  );
  assert.equal(
    fixture.timing.snapshot(performance.now()).stretchUnavailableFrames,
    1,
    "44.1 kHz では数えること",
  );
  // 鳴らし方は変わらない (鳴らした音として数える)
  assert.equal(fixture.timing.snapshot(performance.now()).playedFrames, 2);
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
 * 完了条件: 圧縮 (時間圧縮) の増分を閉ループへ渡す。閉ループは「圧縮が続くときだけ目標の
 * 上限を 160 ms へ広げる」判断に使い、累積ではなく増分を 1 秒ぶん足し合わせる
 * (`src/playout/audioDelayFeedback.ts`)。
 */
test("observeDelayFeedback: 圧縮の増分を閉ループへ渡す", () => {
  const fixture = makeSessionFixture();
  // 閉ループへ観測を渡す時刻を指定して呼ぶ (実時間を待たずに毎秒の制御を再現する)
  const observe = (atMs: number): void => {
    (
      fixture.session as unknown as {
        observeDelayFeedback(atMs: number, timeline: PlayoutTimeline): void;
      }
    ).observeDelayFeedback(atMs, fixture.timeline);
  };
  // 1 回目の観測 (制御の起点)。この時点では圧縮は無い
  observe(0);
  assert.equal(
    fixture.timeline.delayBreakdown.audioDelayFeedback.compressionMsPerSecond,
    0,
    "圧縮が無ければ 0 であること",
  );

  // 詰めを作る。先に目標が未来の音を並べてキューの余裕を作り、目標を過ぎた音を繋げる
  // (余裕が無いと詰めない。src/playout/audioPlayout.ts)
  const target = (targetStartSeconds: number) => ({
    targetStartSeconds,
    arrivalSeconds: targetStartSeconds,
    enforceTarget: true,
    delaySeconds: 0.08,
    arrivalDelaySeconds: 0.08,
    presentationDelaySeconds: 0.08,
  });
  const soundSeconds = SOUND_INTERVAL_MS / 1_000;
  assert.equal(fixture.session.playout.schedule(10, 0, soundSeconds, target(10.2)).kind, "play");
  const decision = fixture.session.playout.schedule(10.2, 20_000, soundSeconds, target(10.2));
  assert.equal(decision.kind, "play");
  if (decision.kind !== "play") {
    return;
  }
  assert.closeTo(decision.compressSeconds, 0.01, 1e-9, "10 ms 詰めること");
  fixture.session.playout.confirmStretch(decision.compressSeconds);
  assert.closeTo(fixture.session.playout.compressed, 0.01, 1e-9, "詰めの累積が 10 ms であること");

  // 2 回目は 1 秒後。この 1 秒間に出た圧縮の増分が、そのまま速さ (10 ms / 秒) になる
  observe(AUDIO_DELAY_FEEDBACK_INTERVAL_MS);
  assert.closeTo(
    fixture.timeline.delayBreakdown.audioDelayFeedback.compressionMsPerSecond,
    10,
    1e-6,
    "圧縮の増分を 1 秒ぶんの速さとして渡すこと",
  );

  // 3 回目は圧縮が無い。累積を渡していれば 10 のままになるため、増分であることが分かる
  observe(AUDIO_DELAY_FEEDBACK_INTERVAL_MS * 2);
  assert.equal(
    fixture.timeline.delayBreakdown.audioDelayFeedback.compressionMsPerSecond,
    0,
    "圧縮が止まれば 0 になること",
  );
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
 * 完了条件 (欠陥 4): 受信の入口で測った入力の遅れを、復号の出力の遅れから引いた
 * 「復号が足している遅れ」で追いつきを決める。入力の遅れも出力の遅れも同じだけ大きい状態
 * (経路が遅いだけ) では作り直さず、入力の遅れが健全なのに出力の遅れだけが大きい状態
 * (受信側が溜めている) では作り直す。
 */
test("handleDecodedAudio: 入力の遅れを引いた「復号が足している遅れ」で追いつきを決める", () => {
  // (1) 経路が 200 ms 遅いだけの状態。Object の到着も復号の出力も同じだけ遅れている
  const pathOnly = makeSessionFixture();
  const pathOutput = makeRecordingOutput({
    timeline: pathOnly.timeline,
    mapping: null,
    currentTimeSeconds: 10,
  });
  for (let index = 0; index < 20; index++) {
    const result = handleSound(pathOnly, pathOutput.output, {
      // 復号の出力の遅れ (到着 - TIMESTAMP) が 200 ms 前後になる
      timestamp: wallClockTimestampMicros() - 200_000,
      // 受信の入口で測った入力の遅れも同じ 200 ms である
      inputLagMs: 200,
    });
    assert.equal(result.status, "played");
    assert.equal(
      result.status === "skipped" ? undefined : result.catchUpStarted,
      false,
      "経路が遅いだけの状態では作り直さないこと",
    );
  }
  const pathSnapshot = pathOnly.session.catchUp.snapshot();
  assert.closeTo(pathSnapshot.inputLagMs ?? 0, 200, 20, "入力の遅れを観測すること");
  assert.isBelow(
    pathSnapshot.decodeLagMs ?? Number.NaN,
    AUDIO_RECEIVE_CATCH_UP_MIN_MS,
    "復号が足している遅れは小さいこと",
  );
  assert.equal(pathSnapshot.catchUpStarts, 0, "作り直しを求めないこと");

  // (2) 入力の遅れが健全なのに、復号の出力の遅れだけが 200 ms (受信側が溜めている)
  const stuck = makeSessionFixture();
  const stuckOutput = makeRecordingOutput({
    timeline: stuck.timeline,
    mapping: null,
    currentTimeSeconds: 10,
  });
  // まず健全な状態 (入力の遅れ 20 ms、出力の遅れ 20 ms) を観測して床を作る
  for (let index = 0; index < 5; index++) {
    const healthy = handleSound(stuck, stuckOutput.output, {
      timestamp: wallClockTimestampMicros() - 20_000,
      inputLagMs: 20,
    });
    assert.equal(
      healthy.status === "skipped" ? undefined : healthy.catchUpStarted,
      false,
      "健全な状態では始めないこと",
    );
  }
  // 入力の遅れは 20 ms のまま、復号の出力の遅れだけを 200 ms へ上げる
  const stepped = handleSound(stuck, stuckOutput.output, {
    timestamp: wallClockTimestampMicros() - 200_000,
    inputLagMs: 20,
  });
  assert.equal(
    stepped.status === "skipped" ? undefined : stepped.catchUpStarted,
    true,
    "受信側が溜めている状態では作り直すこと",
  );
  const stuckSnapshot = stuck.session.catchUp.snapshot();
  assert.closeTo(stuckSnapshot.decodeLagMs ?? 0, 180, 20, "復号が足している遅れを観測すること");
  assert.closeTo(stuckSnapshot.floorMs ?? 0, 0, 20, "床は健全な値のままであること");
  assert.equal(stuckSnapshot.catchUpStarts, 1);
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

/**
 * 完了条件: 購読側が意図して復号を遅らせている場合、その遅延は復号器に溜まった遅れではない。
 * 出力の遅れから意図した遅延を引いた値が健全な範囲なら、追いつきを始めない。同じ観測でも
 * 意図した遅延を指定しなければ、従来どおり復号器の詰まりとして作り直しを求める。
 */
test("handleDecodedAudio: 意図した復号前の遅延では追いつきを始めない", () => {
  // 2 秒遅らせている。出力の遅れは約 2,020 ms、入力の遅れは 20 ms である
  const delayedLagMicros = 2_020_000;
  const intentionalDelayMs = 2_000;

  const delayed = makeSessionFixture();
  const delayedOutput = makeRecordingOutput({
    timeline: delayed.timeline,
    mapping: null,
    currentTimeSeconds: 10,
  });
  for (let index = 0; index < 20; index++) {
    const result = handleSound(delayed, delayedOutput.output, {
      timestamp: wallClockTimestampMicros() - delayedLagMicros,
      inputLagMs: 20,
      intentionalDelayMs,
    });
    assert.equal(result.status, "played");
    assert.equal(
      result.status === "skipped" ? undefined : result.catchUpStarted,
      false,
      "意図した遅延では復号器を作り直さないこと",
    );
  }
  const delayedSnapshot = delayed.session.catchUp.snapshot();
  assert.closeTo(delayedSnapshot.lagMs ?? 0, 2_020, 50, "出力の遅れは意図した遅延を含むこと");
  assert.isBelow(
    delayedSnapshot.decodeLagMs ?? Number.NaN,
    AUDIO_RECEIVE_CATCH_UP_MIN_MS,
    "意図した遅延を引いた復号の遅れは小さいこと",
  );
  assert.equal(delayedSnapshot.catchUpStarts, 0);

  // 同じ出力の遅れでも、意図した遅延を指定しなければ復号器が詰まっていると判定する
  const legacy = makeSessionFixture();
  const legacyOutput = makeRecordingOutput({
    timeline: legacy.timeline,
    mapping: null,
    currentTimeSeconds: 10,
  });
  // まず健全な遅れ (20 ms) を観測して床を作る。床が 2 秒の遅れで埋まると、同じ遅れが
  // 続いても段差として扱われない
  for (let index = 0; index < 5; index++) {
    handleSound(legacy, legacyOutput.output, {
      timestamp: wallClockTimestampMicros() - 20_000,
      inputLagMs: 20,
    });
  }
  const legacyResult = handleSound(legacy, legacyOutput.output, {
    timestamp: wallClockTimestampMicros() - delayedLagMicros,
    inputLagMs: 20,
  });

  assert.equal(
    legacyResult.status === "skipped" ? undefined : legacyResult.catchUpStarted,
    true,
    "意図した遅延を指定しなければ従来どおり作り直すこと",
  );
  assert.equal(legacy.session.catchUp.snapshot().catchUpStarts, 1);
});

/**
 * 完了条件: 予約できる隙間は補間で埋め、補間の末尾と直後の音声の先頭を 2 ms フェードする。
 * 穴が無い通常の境界にはフェードを入れない (20 ms 周期の振幅変調になるため)。
 */
test("handleDecodedAudio: 予約できる隙間を補間し、補間の末尾と次の先頭をフェードする", () => {
  const fixture = makeSessionFixture();
  const samples = [constantSamples(0.2)];
  const output = makeRecordingOutput({
    timeline: fixture.timeline,
    mapping: null,
    currentTimeSeconds: 10,
    mappingFromCurrentTime: true,
  });

  // 到着基準で 1 つ目を鳴らす (今 + 再生の遅れ)
  handleSound(fixture, output.output, {
    timestamp: 0,
    timestampKind: "none",
    useTimeline: false,
    enforceTarget: false,
    samples,
  });
  // 80 ms 進んだ timestamp の音が届くと、前の音の終わりから 80 ms の隙間になる。
  // 前の音の終わりはまだ未来であり、隙間は予約できる
  handleSound(fixture, output.output, {
    timestamp: 80_000,
    timestampKind: "none",
    useTimeline: false,
    enforceTarget: false,
    samples,
  });

  // 予約したのは 1 つ目の実音、2 つ目の補間、2 つ目の実音である
  assert.equal(output.recordedBuffers.length, 3, "実音と補間を予約すること");
  const conceal = output.recordedBuffers[1];
  const real = output.recordedBuffers[2];
  assert.isNotNull(conceal);
  assert.isNotNull(real);
  // 80 ms 進んだ timestamp のうち、音の長さ 20 ms を引いた 60 ms が隙間である
  assert.isAbove((conceal?.channels[0]?.length ?? 0) / SAMPLE_RATE, 0.05, "隙間を補間すること");
  // 補間の末尾は 2 ms フェードで 0 になる
  assert.closeTo(
    conceal?.channels[0]?.[(conceal?.channels[0]?.length ?? 1) - 1] ?? Number.NaN,
    0,
    1e-6,
    "補間の末尾を 0 に落とすこと",
  );
  // 直後の実音の先頭もフェードインで 0 から始まる
  assert.closeTo(
    real?.channels[0]?.[0] ?? Number.NaN,
    0,
    1e-6,
    "次の音の先頭をフェードインすること",
  );
  // 隙間は補間で埋まったため、無音の穴としては数えない
  const snapshot = fixture.timing.snapshot(performance.now());
  assert.equal(snapshot.gapCount, 0, "補間で埋めた隙間を無音として数えないこと");
  assert.equal(snapshot.unrecoverableGapCount, 0);
  assert.equal(snapshot.boundaryStepCount, 0, "補間の継ぎ目に大きな段差が無いこと");
  assert.isAbove(fixture.session.concealedSeconds, 0.05, "補間した長さを記録すること");
});

/**
 * 完了条件: 予約時点で既に過去の隙間 (アンダーラン) は補間できず、無音の穴として計器に出る。
 * 補間できる未来の分だけを補間し、補間の先頭も無音から立ち上がるためフェードインする。
 */
test("handleDecodedAudio: 予約できない隙間を無音の穴として数える", () => {
  const fixture = makeSessionFixture();
  const samples = [constantSamples(0.2)];
  const output = makeRecordingOutput({
    timeline: fixture.timeline,
    mapping: null,
    currentTimeSeconds: 10,
    mappingFromCurrentTime: true,
    advanceOnTimestampMs: 200,
  });

  handleSound(fixture, output.output, {
    timestamp: 0,
    timestampKind: "none",
    useTimeline: false,
    enforceTarget: false,
    samples,
  });
  // 40 ms 進んだ timestamp の音。到着も 200 ms 進むため、前の音の終わり (今 + 70 ms) は
  // 既に過去になり、今回の目標も今 + 余裕より過去になる
  handleSound(fixture, output.output, {
    timestamp: 40_000,
    timestampKind: "none",
    useTimeline: false,
    enforceTarget: false,
    samples,
  });

  const snapshot = fixture.timing.snapshot(performance.now());
  assert.equal(snapshot.gapCount, 1, "無音の穴を 1 つ数えること");
  assert.isAbove(snapshot.gapMs, 100, "穴の長さ (100 ms 以上) を数えること");
  assert.closeTo(snapshot.gapMs, snapshot.gapMaxMs, 1e-6, "1 回の穴なので合計と最大が一致すること");
  assert.equal(snapshot.unrecoverableGapCount, 1, "予約できない穴として数えること");
  assert.isAbove(snapshot.unrecoverableGapMs, 100, "予約できない長さを数えること");
  // 無音へ落ちる直前の音の末尾が段差として残る (片側だけはフェードできない)
  assert.isAtLeast(snapshot.boundaryStepCount, 1, "無音の手前の段差を数えること");
  assert.closeTo(snapshot.boundaryStepMax, 0.2, 1e-6, "段差の振幅は前の音の末尾であること");
  // 直後の実音の先頭はフェードインで 0 から始まる
  const real = output.recordedBuffers[output.recordedBuffers.length - 1];
  assert.closeTo(
    real?.channels[0]?.[0] ?? Number.NaN,
    0,
    1e-6,
    "次の音の先頭をフェードインすること",
  );
});

/**
 * 完了条件: 穴が無い通常の境界にはフェードを入れない。全バッファ境界に一律のフェードを
 * 入れると 20 ms 周期の振幅変調になるためである。
 */
test("handleDecodedAudio: 穴が無い境界にはフェードを入れない", () => {
  const fixture = makeSessionFixture();
  const samples = [constantSamples(0.2)];
  const output = makeRecordingOutput({
    timeline: fixture.timeline,
    mapping: null,
    currentTimeSeconds: 10,
    mappingFromCurrentTime: true,
  });

  for (let index = 0; index < 2; index++) {
    handleSound(fixture, output.output, {
      timestamp: index * 20_000,
      timestampKind: "none",
      useTimeline: false,
      enforceTarget: false,
      samples,
    });
  }

  assert.equal(output.recordedBuffers.length, 2);
  // 2 つ目の先頭はフェードされておらず、元の振幅のままである
  assert.closeTo(
    output.recordedBuffers[1]?.channels[0]?.[0] ?? Number.NaN,
    0.2,
    1e-6,
    "穴が無い境界の先頭はフェードしないこと",
  );
  const snapshot = fixture.timing.snapshot(performance.now());
  assert.equal(snapshot.gapCount, 0);
  assert.equal(snapshot.boundaryStepCount, 0, "連続した音の境界を段差として数えないこと");
});

/**
 * 完了条件: 予約した時刻を currentTime が追い越したら、計器に回数と最大を残す。
 * 追い越しは直前の音との重なりになり得るため、値が 1 でも出たら重なりの可能性がある。
 */
test("handleDecodedAudio: 予約した時刻を currentTime が追い越したら計器に残す", () => {
  const fixture = makeSessionFixture();
  const samples = [constantSamples(0.2)];
  const output = makeRecordingOutput({
    timeline: fixture.timeline,
    mapping: null,
    currentTimeSeconds: 10,
    mappingFromCurrentTime: true,
    advanceOnTimestampMs: 120,
    createBufferWorkMs: 60,
  });

  handleSound(fixture, output.output, {
    timestamp: 0,
    timestampKind: "none",
    useTimeline: false,
    enforceTarget: false,
    samples,
  });
  // 前の音は既に鳴り終わっており、今回は到着 + 再生の遅れ (50 ms) で鳴らす。createBuffer で
  // 60 ms 進むため、start() の時点で予約時刻を追い越す
  handleSound(fixture, output.output, {
    timestamp: 200_000,
    timestampKind: "none",
    useTimeline: false,
    enforceTarget: false,
    samples,
  });

  const snapshot = fixture.timing.snapshot(performance.now());
  assert.isAtLeast(snapshot.lateStartCount, 1, "追い越しを数えること");
  assert.isAbove(snapshot.lateStartMaxMs, 0, "追い越した長さを残すこと");
  // 予約は今 + 余裕で決まり、createBuffer の 12 ms が余裕の 10 ms を超えるため追い越す
  assert.isAbove(snapshot.lateStartMaxMs, 0);
  const lastBuffer = output.recordedBuffers[output.recordedBuffers.length - 1];
  assert.isAbove(
    lastBuffer?.currentTimeAtStart ?? Number.NEGATIVE_INFINITY,
    lastBuffer?.whenSeconds ?? Number.POSITIVE_INFINITY,
    "start() の時点で予約時刻が過去になっていること",
  );
});

/**
 * 完了条件: 目標の表示時刻が前のフレームから 20 µs〜0.4 ms だけ後ろにずれても、出力に
 * ゼロサンプルを挟まず、境界の段差を計器に数えない。目標の更新と浮動小数点の丸めで
 * 生じる微小な前進は、前の音の終わりに揃えて連続再生で吸収する。
 */
test("handleDecodedAudio: 目標の 20 µs〜0.4 ms の前進を前の音の終わりに揃える", () => {
  for (const offsetMs of [0.02, 0.1, 0.4]) {
    const fixture = makeSessionFixture();
    const output = makeRecordingOutput({
      timeline: fixture.timeline,
      mapping: null,
      currentTimeSeconds: 10,
      mappingFromCurrentTime: true,
      advanceOnTimestampMs: offsetMs,
    });

    // 到着基準で 1 つ目を鳴らす
    handleSound(fixture, output.output, {
      timestamp: 0,
      timestampKind: "none",
      useTimeline: false,
      enforceTarget: false,
      samples: [toneSamples(0)],
    });
    // 2 つ目は到着が offsetMs 進み、timestamp が 20 ms + offsetMs 進む。前の音の終わりから
    // offsetMs の隙間ができるが、下限 (0.5 ms) 以下なので前の音の終わりに揃える
    handleSound(fixture, output.output, {
      timestamp: 20_000 + Math.round(offsetMs * 1_000),
      timestampKind: "none",
      useTimeline: false,
      enforceTarget: false,
      samples: [toneSamples(1)],
    });

    assert.equal(output.recordedBuffers.length, 2);
    const first = output.recordedBuffers[0];
    const second = output.recordedBuffers[1];
    assert.isNotNull(first);
    assert.isNotNull(second);
    // 2 つのバッファはサンプル単位で連続している (間に 1 サンプルのゼロも無い)
    assert.closeTo(
      second?.whenSeconds ?? Number.NaN,
      (first?.whenSeconds ?? Number.NaN) +
        (first?.channels[0]?.length ?? 0) / (first?.sampleRate ?? SAMPLE_RATE),
      1e-9,
      "前の音の終わりに揃えて連続すること",
    );
    const tail = first?.channels[0]?.[(first?.channels[0]?.length ?? 1) - 1] ?? 0;
    const head = second?.channels[0]?.[0] ?? 0;
    assert.isAbove(Math.abs(tail), 0.001, "末尾が 0 でないこと");
    assert.isAbove(Math.abs(head), 0.001, "先頭が 0 でないこと");
    assert.isBelow(Math.abs(head - tail), 0.05, "境界の段差が自然な差分以下であること");
    const snapshot = fixture.timing.snapshot(performance.now());
    assert.equal(snapshot.gapCount, 0, "穴として数えないこと");
    assert.equal(snapshot.boundaryStepCount, 0, "段差として数えないこと");
    assert.equal(fixture.session.playout.lateness, 0, "遅れを負にしないこと");
  }
});
