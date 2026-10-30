/** 実音声の予約と canvas の表示を、同じ媒体時刻で照合する A/V の測定。 */
import { loadSpeech, opusFrames } from "./playout-audio-input.mjs";

import {
  requireAudioFrame,
  hasAvCoverage,
  joinCaptureBlocks,
  watchProcessorErrors,
} from "./playout-measurement-guards.mjs";
import { createArrivalEvents } from "./playout-arrival-events.mjs";
import { pairPresentationDelays } from "./devtools-latency-trace.mjs";

const RATE = 48000;
const FRAME = 960;
const sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** 分布は保存した全フレームから求め、末尾だけの統計窓と区別する。 */
function distribution(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const percentile = (fraction) =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? null;
  return {
    samples: sorted.length,
    p50: percentile(0.5),
    p95: percentile(0.95),
    max: sorted.at(-1) ?? null,
  };
}

export async function measure(
  caseName,
  { moduleUrl, variant, seconds, arrivalTrace, comparisonModuleUrl },
) {
  const modules = await Promise.all(
    [moduleUrl, ...(comparisonModuleUrl ? [comparisonModuleUrl] : [])].map((url) => import(url)),
  );
  const [, name, pattern] = caseName.split("|");
  const count = Math.round(seconds * 50);
  const decoded =
    name === "tone" ? null : await opusFrames(170, count, await loadSpeech(name, seconds));
  const channels = Array.from({ length: count }, (_, index) =>
    decoded === null
      ? Float32Array.from(
          { length: FRAME },
          (_, sample) => 0.3 * Math.sin((2 * Math.PI * 170 * (index * FRAME + sample)) / RATE),
        )
      : requireAudioFrame(decoded[index], index, FRAME),
  );
  const context = new AudioContext({ sampleRate: RATE, latencyHint: "interactive" });
  const states = [];
  let source = null;

  try {
    const workletUrl = URL.createObjectURL(
      new Blob(
        [
          `class Capture extends AudioWorkletProcessor {
      process(inputs, outputs) {
        const samples = inputs[0]?.[0]?.slice() ?? new Float32Array(outputs[0][0].length);
        this.frames ??= 0;
        this.port.postMessage({ frame: this.frames, renderFrame: currentFrame, samples });
        this.frames += samples.length;
        return true;
      }
    } registerProcessor("av-latency-capture", Capture);`,
        ],
        { type: "text/javascript" },
      ),
    );
    try {
      await context.audioWorklet.addModule(workletUrl);
    } finally {
      URL.revokeObjectURL(workletUrl);
    }
    source = document.createElement("canvas");
    source.width = 64;
    source.height = 64;
    document.body.append(source);
    const paint = source.getContext("2d");
    for (const [index, { createMediaPlayout }] of modules.entries()) {
      const state = {
        audio: [],
        video: [],
        snapshots: [],
        blocks: [],
        videoLateDrops: 0,
        videoQueueDrops: 0,
      };
      // 同じ出力時計で比べ、別の AudioContext の先行量や位相を比較へ混ぜない。
      states.push(state);
      state.tap = new AudioWorkletNode(context, "av-latency-capture");
      state.captureErrors = watchProcessorErrors(state.tap);
      state.tap.port.onmessage = (event) => state.blocks.push(event.data);
      state.mute = context.createGain();
      state.mute.gain.value = 0;
      state.tap.connect(state.mute).connect(context.destination);
      state.destination = document.createElement("canvas");
      state.destination.width = 64;
      state.destination.height = 64;
      document.body.append(state.destination);
      const drawing = state.destination.getContext("2d");
      state.variant = index === 0 ? variant : "comparison";
      state.moduleUrl = index === 0 ? moduleUrl : comparisonModuleUrl;
      state.playout = createMediaPlayout({
        audio: { context, destination: state.tap },
        video: {
          pacing: { drainImmediately: false, framesPerDrain: 1 },
          output: {
            isAvailable: () => state.destination.isConnected,
            present: (frame, plannedMs) => {
              drawing.drawImage(frame, 0, 0);
              state.video.push({
                timestamp: frame.timestamp,
                presentedMs: performance.now(),
                plannedMs,
              });
              frame.close();
              return true;
            },
          },
          timing: {
            recordLateDrop: () => state.videoLateDrops++,
            recordQueueDrop: () => state.videoQueueDrops++,
          },
        },
      });
    }
    await context.resume();
    const deadline = performance.now() + 2000;
    while (context.getOutputTimestamp().performanceTime <= 0) {
      if (performance.now() >= deadline)
        throw new Error("Output clock did not become available within 2000 ms");
      await sleep(10);
    }
    await sleep(100);
    // 出力時計の初期化前の量子は対象外とし、媒体の投入前から連続した収録を始める。
    for (const state of states) state.blocks.length = 0;
    const originMs = performance.now() + 50;
    const epoch = Math.round((performance.timeOrigin + originMs) * 1000);
    const { events, injectedAudioLoss } = createArrivalEvents(
      pattern,
      seconds,
      originMs,
      epoch,
      arrivalTrace,
    );
    const arrivals = [];
    for (const event of events) {
      const remaining = event.arrivalMs - performance.now();
      if (remaining > 0) await sleep(remaining);
      const receivedMs = performance.now();
      arrivals.push({ ...event, receivedMs });
      // 呼び出し順をフレームごとに入れ替え、片方だけが常に先に予約される偏りを避ける。
      const orderedStates = event.index % 2 === 0 ? states : [...states].reverse();
      if (event.stream === "video") {
        paint.fillStyle = `rgb(${event.index % 256}, ${255 - (event.index % 256)}, 120)`;
        paint.fillRect(0, 0, 64, 64);
      }
      for (const state of orderedStates) {
        const { playout, audio, snapshots } = state;
        const pushedMs = performance.now();
        if (event.stream === "audio") {
          const data = new AudioData({
            format: "f32-planar",
            sampleRate: RATE,
            numberOfChannels: 1,
            numberOfFrames: FRAME,
            timestamp: event.timestamp,
            data: channels[event.index],
          });
          try {
            playout.trackAudioDecodeInput(data.timestamp, {
              timestampKind: "wallClock",
              inputLagMs: pushedMs - originMs - event.mediaMs,
            });
            const result = playout.pushAudio(data);
            if (result.status === "error") throw result.error;
            const timing = playout.getStats().audio.timing;
            audio.push({
              timestamp: event.timestamp,
              mediaMs: event.mediaMs,
              receivedMs: pushedMs,
              status: result.status,
              startMs: timing.lastStartMs,
              targetMs: timing.lastTargetMs,
            });
            if (event.index % 25 === 0)
              snapshots.push({ mediaMs: event.mediaMs, stats: playout.getStats() });
          } finally {
            data.close();
          }
        } else {
          const frame = new VideoFrame(source, { timestamp: event.timestamp });
          playout.trackVideoDecodeInput(frame.timestamp, {
            timestampKind: "wallClock",
            location: { group: BigInt(event.index), object: 0n },
          });
          playout.pushVideo(frame);
        }
      }
    }
    const drains = await Promise.all(
      states.map(({ playout }) => playout.drainAudio({ maxWaitMs: 700 })),
    );
    await sleep(150);
    let inputStepMax = 0;
    for (const channel of channels)
      for (let index = 1; index < channel.length; index++)
        inputStepMax = Math.max(inputStepMax, Math.abs(channel[index] - channel[index - 1]));
    const results = states.map((state, stateIndex) => {
      const {
        playout,
        audio,
        video,
        snapshots,
        videoLateDrops,
        videoQueueDrops,
        blocks,
        captureErrors,
      } = state;
      const drain = drains[stateIndex];
      const stats = playout.getStats();
      const activeAudio = audio.filter((row) => row.status === "played" && row.mediaMs >= 1000);
      const activeVideo = video.filter((row) => row.timestamp - epoch >= 1000000);
      const age = (row, at) => at - originMs - (row.timestamp - epoch) / 1000;
      const pairs = pairPresentationDelays(
        audio
          .filter((row) => row.status === "played")
          .map((row) => ({
            timestampMs: row.timestamp / 1000,
            atMs: row.receivedMs,
            delayMs: age(row, row.startMs),
          })),
        activeVideo.map((row) => ({
          timestampMs: row.timestamp / 1000,
          atMs: row.presentedMs,
          delayMs: age(row, row.presentedMs),
        })),
      ).map((row) => ({ mediaMs: (row.timestampMs * 1000 - epoch) / 1000, skewMs: row.delayMs }));
      const { samples, stepMax, missingMs, discontinuities, gaps } = joinCaptureBlocks(
        blocks,
        RATE,
      );
      return {
        caseName,
        valid:
          stepMax > 0 &&
          discontinuities === 0 &&
          hasAvCoverage({
            seconds,
            capturedSamples: samples.length,
            audioCount: activeAudio.length,
            videoCount: activeVideo.length,
            pairCount: pairs.filter((row) => Number.isFinite(row.skewMs)).length,
            captureErrors,
          }),
        variant: state.variant,
        seconds,
        moduleUrl: state.moduleUrl,
        captureMissingMs: missingMs,
        captureErrors: [...captureErrors],
        captureGaps: gaps,
        captureDiscontinuities: discontinuities,
        captureFirstFrame: blocks[0]?.frame ?? null,
        captureLastFrame: blocks.at(-1)?.frame ?? null,
        // currentFrame の重複と直後の飛びは、PCM の収録連番とは別の生データで残す。
        captureFrames: blocks.map(({ frame, renderFrame, samples }) => ({
          frame,
          renderFrame,
          frames: samples.length,
        })),
        originMs,
        epochMicros: epoch,
        timeOriginMs: performance.timeOrigin,
        injectedAudioLoss,
        orderedDecoderOutput: true,
        audioAgeMs: distribution(activeAudio.map((row) => age(row, row.startMs))),
        videoAgeMs: distribution(activeVideo.map((row) => age(row, row.presentedMs))),
        pairedSkewMs: distribution(pairs.map((row) => row.skewMs)),
        pairedAbsoluteSkewMs: distribution(pairs.map((row) => Math.abs(row.skewMs))),
        finalAudioAgeMs: distribution(
          activeAudio
            .filter((row) => row.mediaMs >= seconds * 1000 - 2000)
            .map((row) => age(row, row.startMs)),
        ),
        finalVideoAgeMs: distribution(
          activeVideo
            .filter((row) => row.timestamp - epoch >= (seconds * 1000 - 2000) * 1000)
            .map((row) => age(row, row.presentedMs)),
        ),
        deliveryTimerLatenessMs: distribution(
          arrivals.map((row) => row.receivedMs - row.arrivalMs),
        ),
        stepMax,
        inputStepMax,
        videoLateDrops,
        videoQueueDrops,
        drain,
        stats,
        snapshots,
        audio,
        video,
        arrivals,
        pairs,
        recordings: [
          {
            name: `av-${variant}-${stateIndex}-${name}-${pattern}`,
            sampleRate: RATE,
            samples: Array.from(samples),
          },
        ],
      };
    });
    const [primary, ...comparisons] = results;
    return {
      ...primary,
      valid: results.every((result) => result.valid),
      sharedAudioContext: states.length > 1,
      comparisons: comparisons.map(({ recordings: _recordings, ...metrics }) => metrics),
      recordings: results.flatMap((result) => result.recordings),
    };
  } finally {
    for (const state of states) {
      state.playout?.clearAll();
      state.destination?.remove();
      state.tap?.port.close();
      state.tap?.disconnect();
      state.mute?.disconnect();
    }
    source?.remove();
    await context.close();
  }
}
