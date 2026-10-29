/** 実音声の予約と canvas の表示を、同じ媒体時刻で照合する A/V の測定。 */
import { loadSpeech, opusFrames } from "./playout-audio-input.mjs";

import { requireAudioFrame, hasAvCoverage } from "./playout-measurement-guards.mjs";

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

/** 追加の到着の揺らぎ。音を代替せず、実 AudioData / VideoFrame を渡す時刻だけを変える。 */
function extraDelay(pattern, stream, mediaMs, index) {
  if (
    (pattern === "both-stall" || (pattern === "audio-stall" && stream === "audio")) &&
    mediaMs >= 2000 &&
    mediaMs < 2180
  )
    return 2180 - mediaMs;
  if (pattern === "video-step" && stream === "video" && mediaMs >= 2000 && mediaMs < 5000)
    return 120;
  if (pattern === "jitter") return ((index * 1664525 + 1013904223) >>> 0) % 31;
  return 0;
}

export async function measure(caseName, { moduleUrl, variant, seconds }) {
  const { createMediaPlayout } = await import(moduleUrl);
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
  const blocks = [];
  const workletUrl = URL.createObjectURL(
    new Blob(
      [
        `class Capture extends AudioWorkletProcessor {
      process(inputs, outputs) {
        this.port.postMessage(inputs[0]?.[0]?.slice() ?? new Float32Array(outputs[0][0].length));
        return true;
      }
    } registerProcessor("av-latency-capture", Capture);`,
      ],
      { type: "text/javascript" },
    ),
  );
  await context.audioWorklet.addModule(workletUrl);
  URL.revokeObjectURL(workletUrl);
  const tap = new AudioWorkletNode(context, "av-latency-capture");
  tap.port.onmessage = (event) => blocks.push(event.data);
  const mute = context.createGain();
  mute.gain.value = 0;
  tap.connect(mute).connect(context.destination);
  const source = document.createElement("canvas");
  const destination = document.createElement("canvas");
  source.width = 64;
  destination.width = 64;
  source.height = 64;
  destination.height = 64;
  document.body.append(source, destination);
  const paint = source.getContext("2d");
  const drawing = destination.getContext("2d");
  const audio = [];
  const video = [];
  const snapshots = [];
  let videoLateDrops = 0;
  let videoQueueDrops = 0;
  const playout = createMediaPlayout({
    audio: { context, destination: tap },
    video: {
      pacing: { drainImmediately: false, framesPerDrain: 1 },
      output: {
        isAvailable: () => destination.isConnected,
        present: (frame, plannedMs) => {
          drawing.drawImage(frame, 0, 0);
          video.push({ timestamp: frame.timestamp, presentedMs: performance.now(), plannedMs });
          frame.close();
          return true;
        },
      },
      timing: {
        recordLateDrop: () => videoLateDrops++,
        recordQueueDrop: () => videoQueueDrops++,
      },
    },
  });
  try {
    await context.resume();
    const deadline = performance.now() + 2000;
    while (context.getOutputTimestamp().performanceTime <= 0) {
      if (performance.now() >= deadline)
        throw new Error("Output clock did not become available within 2000 ms");
      await sleep(10);
    }
    await sleep(100);
    const originMs = performance.now() + 50;
    const epoch = Math.round((performance.timeOrigin + originMs) * 1000);
    const events = [];
    let randomState = 0x74219;
    let injectedAudioLoss = 0;
    for (const stream of ["audio", "video"]) {
      const frequency = stream === "audio" ? 50 : 30;
      let previousArrivalMs = -Infinity;
      for (let index = 0; index < seconds * frequency; index++) {
        const mediaMs = (index * 1000) / frequency;
        randomState = (randomState * 1664525 + 1013904223) >>> 0;
        if (stream === "audio" && pattern === "loss5" && randomState / 4294967296 < 0.05) {
          injectedAudioLoss++;
          continue;
        }
        // 復号済みの入口ではトラック内の出力順を保つ。復号前の順序逆転とは分ける。
        const arrivalMs = Math.max(
          previousArrivalMs + 0.1,
          originMs + mediaMs + 20 + extraDelay(pattern, stream, mediaMs, index),
        );
        previousArrivalMs = arrivalMs;
        events.push({
          stream,
          index,
          mediaMs,
          timestamp: epoch + Math.round(mediaMs * 1000),
          arrivalMs,
        });
      }
    }
    events.sort((left, right) => left.arrivalMs - right.arrivalMs || left.mediaMs - right.mediaMs);
    const arrivals = [];
    for (const event of events) {
      const remaining = event.arrivalMs - performance.now();
      if (remaining > 0) await sleep(remaining);
      const receivedMs = performance.now();
      arrivals.push({ ...event, receivedMs });
      if (event.stream === "audio") {
        const data = new AudioData({
          format: "f32-planar",
          sampleRate: RATE,
          numberOfChannels: 1,
          numberOfFrames: FRAME,
          timestamp: event.timestamp,
          data: channels[event.index],
        });
        playout.trackAudioDecodeInput(data.timestamp, {
          timestampKind: "wallClock",
          inputLagMs: receivedMs - originMs - event.mediaMs,
        });
        const result = playout.pushAudio(data);
        data.close();
        if (result.status === "error") throw result.error;
        const timing = playout.getStats().audio.timing;
        audio.push({
          timestamp: event.timestamp,
          mediaMs: event.mediaMs,
          receivedMs,
          status: result.status,
          startMs: timing.lastStartMs,
          targetMs: timing.lastTargetMs,
        });
        if (event.index % 25 === 0)
          snapshots.push({ mediaMs: event.mediaMs, stats: playout.getStats() });
      } else {
        paint.fillStyle = `rgb(${event.index % 256}, ${255 - (event.index % 256)}, 120)`;
        paint.fillRect(0, 0, 64, 64);
        const frame = new VideoFrame(source, { timestamp: event.timestamp });
        playout.trackVideoDecodeInput(frame.timestamp, {
          timestampKind: "wallClock",
          location: { group: BigInt(event.index), object: 0n },
        });
        playout.pushVideo(frame);
      }
    }
    const drain = await playout.drainAudio({ maxWaitMs: 700 });
    await sleep(150);
    const stats = playout.getStats();
    const activeAudio = audio.filter((row) => row.status === "played" && row.mediaMs >= 1000);
    const activeVideo = video.filter((row) => row.timestamp - epoch >= 1000000);
    const audioByTimestamp = new Map(
      audio.filter((row) => row.status === "played").map((row) => [row.timestamp, row]),
    );
    const pairs = activeVideo.flatMap((row) => {
      const matching = audioByTimestamp.get(row.timestamp);
      return matching === undefined
        ? []
        : [{ mediaMs: matching.mediaMs, skewMs: row.presentedMs - matching.startMs }];
    });
    const age = (row, at) => at - originMs - (row.timestamp - epoch) / 1000;
    const samples = new Float32Array(blocks.reduce((sum, block) => sum + block.length, 0));
    let position = 0;
    for (const block of blocks) {
      samples.set(block, position);
      position += block.length;
    }
    let stepMax = 0;
    let inputStepMax = 0;
    for (let index = 1; index < samples.length; index++)
      stepMax = Math.max(stepMax, Math.abs(samples[index] - samples[index - 1]));
    for (const channel of channels)
      for (let index = 1; index < channel.length; index++)
        inputStepMax = Math.max(inputStepMax, Math.abs(channel[index] - channel[index - 1]));
    return {
      caseName,
      valid:
        stepMax > 0 &&
        hasAvCoverage(
          {
            seconds,
            capturedSamples: samples.length,
            audioCount: activeAudio.length,
            videoCount: activeVideo.length,
            pairCount: pairs.filter((row) => Number.isFinite(row.skewMs)).length,
          },
          5,
        ),
      variant,
      seconds,
      moduleUrl,
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
      deliveryTimerLatenessMs: distribution(arrivals.map((row) => row.receivedMs - row.arrivalMs)),
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
          name: `av-${variant}-${name}-${pattern}`,
          sampleRate: RATE,
          samples: Array.from(samples),
        },
      ],
    };
  } finally {
    playout.clearAll();
    source.remove();
    destination.remove();
    tap.disconnect();
    mute.disconnect();
    await context.close();
  }
}
