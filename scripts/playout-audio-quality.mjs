/** 実ブラウザだけで読み込む調査用の音源、解析、収録。モックは使わない。 */
import { compressSamples, concealSamples } from "../src/playout/audioTimeStretch.ts";
import {
  crossFadeHead,
  fadeSpliceEdge,
  interpolateSpliceGap,
  smoothSpliceHead,
} from "../src/audioSpliceFade.ts";
import { createMediaPlayout } from "../src/playout/mediaPlayout.ts";
import {
  AUDIO_PLAYOUT_MIN_LEAD_SECONDS,
  AudioPlayoutScheduler,
  concealmentEndGain,
} from "../src/playout/audioPlayout.ts";

import { frameAt, opusFrames, loadSpeech } from "./playout-audio-input.mjs";
import { requireAudioFrame } from "./playout-measurement-guards.mjs";

// 旧 DSP の比較は、その比較を実行するときだけ読み込む。
async function comparisons() {
  const [before, baseline] = await Promise.all([
    import("../investigation-logs/playout-quality-2026-10-28/audioTimeStretch.before.ts"),
    import("../investigation-logs/playout-quality-2026-10-28/audioTimeStretch.baseline.ts"),
  ]);
  return { before, baseline };
}
const RATE = 48000;
const FRAME = 960;
const db = (ratio) => 10 * Math.log10(Math.max(1e-16, ratio));
const energy = (samples) => samples.reduce((sum, sample) => sum + sample * sample, 0);
const percentile = (values, fraction) => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
};

/** 同じ媒体位置に対応する波形との差。全体の遅延や伸縮を音質の誤差へ混ぜない。 */
function frameError(actual, expected) {
  let squaredError = 0;
  let referenceEnergy = 0;
  for (let index = 0; index < actual.length; index++) {
    const reference = expected[index] ?? 0;
    squaredError += ((actual[index] ?? 0) - reference) ** 2;
    referenceEnergy += reference ** 2;
  }
  return { squaredError, referenceEnergy };
}

/** 50 Hz の音量変動を、1 ms ごとの RMS の複素振幅で測る。 */
function envelope50(samples, rate, frequency = 50) {
  const block = Math.round(rate / 1000);
  let sum = 0;
  let real = 0;
  let imaginary = 0;
  let count = 0;
  for (let index = 0; index + block <= samples.length; index += block) {
    const rms = Math.sqrt(energy(samples.subarray(index, index + block)) / block);
    const phase = (2 * Math.PI * frequency * (index + block / 2)) / rate;
    sum += rms;
    real += rms * Math.cos(phase);
    imaginary += rms * Math.sin(phase);
    count++;
  }
  return {
    modulationDb: db((4 * (real ** 2 + imaginary ** 2)) / Math.max(1e-30, sum ** 2)),
    meanRms: sum / count,
  };
}

/** 連続 0.5 ms 以上の無音と、不連続候補を数える。音声の自然な無音も区別して解釈する。 */
function summarize(samples, rate) {
  let silenceSamples = 0;
  let silenceRuns = 0;
  let run = 0;
  const steps = [];
  for (let index = 0; index < samples.length; index++) {
    if (Math.abs(samples[index] ?? 0) < 1e-7) {
      run++;
    } else {
      if (run >= rate * 0.0005) {
        silenceSamples += run;
        silenceRuns++;
      }
      run = 0;
    }
    if (index > 0) steps.push(Math.abs((samples[index] ?? 0) - (samples[index - 1] ?? 0)));
  }
  // 収録の先頭と末尾の無音は、呼び出し側で有効区間へ切り詰めてから渡す。
  return {
    rms: Math.sqrt(energy(samples) / samples.length),
    stepMax: steps.reduce((maximum, value) => Math.max(maximum, value), 0),
    stepP999: percentile(steps, 0.999),
    silenceRuns,
    silenceMs: (silenceSamples / rate) * 1000,
    ...envelope50(samples, rate),
  };
}

export async function dsp() {
  const { before, baseline } = await comparisons();
  const compression = [];
  const concealment = [];
  const stereo = [];
  const recordings = [];
  for (const rate of [44100, 48000]) {
    for (const frequency of [
      80, 100, 120, 140, 150, 160, 170, 180, 200, 220, 240, 260, 300, 390, 440,
    ]) {
      for (const kind of ["sine", "voiced", "speech"]) {
        for (const [version, compress] of [
          ["before", before.compressSamples],
          ["baseline", baseline.compressSamples],
          ["current", compressSamples],
        ]) {
          let accepted = 0;
          let removed = 0;
          let squaredError = 0;
          let referenceEnergy = 0;
          const output = [];
          const periodErrors = [];
          for (let index = 0; index < 100; index++) {
            const input = frameAt(index, rate, frequency, kind);
            const result = compress([input], rate, input.length / 2);
            const actual = result.channels[0];
            if (result.lengthChangeSamples < 0) {
              accepted++;
              periodErrors.push(Math.abs(-result.lengthChangeSamples - rate / frequency));
            }
            removed -= result.lengthChangeSamples;
            const error = frameError(actual, input);
            squaredError += error.squaredError;
            referenceEnergy += error.referenceEnergy;
            output.push(...actual);
          }
          compression.push({
            rate,
            frequency,
            kind,
            version,
            accepted,
            removedMs: (removed / rate) * 1000,
            errorDb: db(squaredError / Math.max(1e-30, referenceEnergy)),
            periodErrorP50: percentile(periodErrors, 0.5),
            ...envelope50(Float32Array.from(output), rate),
          });
          if (rate === RATE && kind === "voiced" && [80, 140, 150, 180, 220].includes(frequency)) {
            recordings.push({
              name: `compress-${String(version)}-${String(frequency)}`,
              sampleRate: rate,
              samples: output,
            });
          }
        }
      }
      // 圧縮前後の 20 ms の材料で、5 ms の穴を補間できる割合を比較する。
      for (const kind of ["sine", "voiced"]) {
        let rawSuccess = 0;
        let compressedSuccess = 0;
        let compressedFrames = 0;
        for (let index = 0; index < 100; index++) {
          const input = frameAt(index, rate, frequency, kind);
          const result = compressSamples([input], rate, input.length / 2);
          if (result.lengthChangeSamples < 0) compressedFrames++;
          if (concealSamples([input], rate, 0.005).generatedSamples > 0) rawSuccess++;
          if (concealSamples(result.channels, rate, 0.005).generatedSamples > 0)
            compressedSuccess++;
        }
        concealment.push({
          rate,
          frequency,
          kind,
          rawSuccess,
          compressedSuccess,
          compressedFrames,
        });
      }
    }
  }
  // 左右が違う周期でも、左だけで決めた圧縮を右へ適用してしまわないか調べる。
  for (const rightFrequency of [200, 233, 333, 400, 440]) {
    let rightError = 0;
    let rightReference = 0;
    let leftError = 0;
    let leftReference = 0;
    let rightEnergy = 0;
    let unprocessedEnergy = 0;
    const concealment = new Map(
      ["baseline", "current"].map((version) => [
        version,
        { accepted: 0, squaredError: 0, referenceEnergy: 0 },
      ]),
    );
    for (let index = 0; index < 100; index++) {
      const left = frameAt(index, RATE, 200);
      const right = frameAt(index, RATE, rightFrequency);
      const result = compressSamples([left, right], RATE, FRAME / 2);
      const leftMetrics = frameError(result.channels[0], left);
      const rightMetrics = frameError(result.channels[1], right);
      leftError += leftMetrics.squaredError;
      leftReference += leftMetrics.referenceEnergy;
      rightError += rightMetrics.squaredError;
      rightReference += rightMetrics.referenceEnergy;
      rightEnergy += energy(result.channels[1]);
      unprocessedEnergy += energy(right.subarray(0, result.channels[1].length));
      for (const [version, conceal] of [
        ["baseline", baseline.concealSamples],
        ["current", concealSamples],
      ]) {
        const generated = conceal([left, right], RATE, 0.02);
        if (generated.generatedSamples === 0) continue;
        const metric = concealment.get(version);
        metric.accepted++;
        const error = frameError(generated.channels[1], frameAt(index + 1, RATE, rightFrequency));
        metric.squaredError += error.squaredError;
        metric.referenceEnergy += error.referenceEnergy;
      }
    }
    stereo.push({
      leftFrequency: 200,
      rightFrequency,
      leftErrorDb: db(leftError / leftReference),
      rightErrorDb: db(rightError / rightReference),
      rightEnergyDb: db(rightEnergy / unprocessedEnergy),
      concealment: Object.fromEntries(
        [...concealment].map(([version, metric]) => [
          version,
          {
            accepted: metric.accepted,
            rightErrorDb:
              metric.accepted === 0 ? null : db(metric.squaredError / metric.referenceEnergy),
          },
        ]),
      ),
    });
  }
  return { compression, concealment, stereo, recordings };
}

/** 実 WebCodecs で Opus を一往復させた波形。入力と復号後の timestamp は区別する。 */
function isMissingFrame(pattern, index) {
  return (
    (pattern === "loss20" && index > 0 && index % 20 === 0) ||
    (pattern === "loss-voice" && index % 20 === 7)
  );
}

/** 同じ到着列を実 DSP と実 OfflineAudioContext へ通す 1 条件。 */
async function renderCase(
  kind,
  pattern,
  treatment,
  opus,
  speechName,
  cases,
  recordings,
  inducedLosses,
) {
  const { baseline } = await comparisons();
  const context = new OfflineAudioContext(1, RATE * (speechName === null ? 4 : 8), RATE);
  const scheduler = new AudioPlayoutScheduler(
    treatment === "no-compress" ? { stretchMinSeconds: 10 } : {},
  );
  let previous = null;
  let previousFrameIndex = -1;
  let totalGapMs = 0;
  let concealedMs = 0;
  let requested = 0;
  let applied = 0;
  let failedConcealments = 0;
  let previousEnd = 0;
  let finalEnd = 0;
  const boundaries = [];
  let pendingGain = null;
  const schedule = (samples, when) => {
    const buffer = context.createBuffer(1, samples.length, RATE);
    buffer.copyToChannel(samples, 0);
    const node = context.createBufferSource();
    node.buffer = buffer;
    if (treatment === "current") {
      if (pendingGain !== null && Math.abs(when - pendingGain.end) <= 0.5 / RATE) {
        pendingGain.node.gain.cancelScheduledValues(pendingGain.tailStart);
        pendingGain.node.gain.setValueAtTime(1, pendingGain.tailStart);
      }
      const gain = context.createGain();
      const duration = samples.length / RATE;
      const fade = Math.min(0.002, duration / 2);
      if (pendingGain === null) {
        gain.gain.value = 0;
        gain.gain.setValueAtTime(0, when);
        gain.gain.linearRampToValueAtTime(1, when + fade);
      }
      const tailStart = when + duration - fade;
      gain.gain.setValueAtTime(1, tailStart);
      gain.gain.linearRampToValueAtTime(0, when + duration);
      node.connect(gain).connect(context.destination);
      pendingGain = { node: gain, tailStart, end: when + duration };
    } else node.connect(context.destination);
    node.start(when);
  };
  for (let index = 0; index < (speechName === null ? 150 : 300); index++) {
    if (inducedLosses.has(index)) continue;
    if (isMissingFrame(pattern, index)) continue;
    const offset = index * 0.02;
    const moving =
      pattern === "target-rise"
        ? index * 0.001
        : pattern === "target-fall" || pattern === "compress-then-loss"
          ? -index * 0.0002
          : 0;
    const decision = scheduler.schedule(offset, index * 20000, 0.02, {
      targetStartSeconds: offset + 0.12 + moving,
      enforceTarget: true,
      arrivalSeconds: offset,
      delaySeconds: 0.3,
      arrivalDelaySeconds: 0.12,
      presentationDelaySeconds: 0.3,
    });
    if (decision.kind !== "play") throw new Error("Unexpected drop in rendering experiment");
    const input =
      kind === "opus"
        ? (opus[index]?.samples ?? new Float32Array(FRAME))
        : frameAt(index, RATE, 170, kind);
    const result =
      decision.compressSeconds > 0
        ? (treatment === "baseline" ? baseline.compressSamples : compressSamples)(
            [input],
            RATE,
            Math.round(decision.compressSeconds * RATE),
          )
        : { channels: [input], lengthChangeSamples: 0 };
    requested += Number(decision.compressSeconds > 0);
    applied += Number(result.lengthChangeSamples < 0);
    scheduler.confirmStretch(-result.lengthChangeSamples / RATE);
    let concealedSeconds = 0;
    let continuation = null;
    let concealmentEnd = null;
    if (decision.gapSeconds > 0 && previous !== null) {
      let concealed = concealSamples(
        previous,
        RATE,
        decision.gapSeconds + (treatment === "current" ? 0.002 : 0),
        concealmentEndGain(decision.gapSeconds),
      );
      if (
        treatment === "current" &&
        concealed.generatedSamples === 0 &&
        decision.gapSeconds <= 0.002
      ) {
        const frames = Math.round(decision.gapSeconds * RATE);
        const gap = interpolateSpliceGap(previous, result.channels, frames);
        concealed = {
          generatedSamples: frames,
          channels: gap.map((channel, index) => {
            const joined = new Float32Array(frames + result.channels[index].length);
            joined.set(channel);
            joined.set(result.channels[index], frames);
            return joined;
          }),
        };
      }
      if (concealed.generatedSamples > 0) {
        if (treatment === "current" && decision.unrecoverableGapSeconds === 0)
          concealed.channels = smoothSpliceHead(previous, concealed.channels, RATE);
        const frames = Math.round(decision.gapSeconds * RATE);
        const segment = concealed.channels.map((channel) => channel.slice(0, frames));
        if (treatment === "current")
          continuation = concealed.channels.map((channel) => channel.slice(frames));
        const channels =
          treatment === "no-extra-fade" || treatment === "current"
            ? segment
            : fadeSpliceEdge(segment, RATE, "tail");
        schedule(channels[0], decision.gapStartSeconds);
        concealedSeconds = frames / RATE;
        concealmentEnd = decision.gapStartSeconds + concealedSeconds;
      } else failedConcealments++;
    }
    scheduler.confirmConcealment(concealedSeconds);
    totalGapMs += decision.totalGapSeconds * 1000;
    concealedMs += concealedSeconds * 1000;
    const { output, startAt } = joinRenderedAudio(
      treatment,
      concealmentEnd,
      decision,
      continuation,
      result.channels,
      index - previousFrameIndex > 1,
      previous,
    );
    schedule(output[0], startAt);
    if (index > 0) boundaries.push({ at: startAt, previousEnd });
    previousEnd = startAt + output[0].length / RATE;
    if (treatment === "current") scheduler.confirmPlayoutEnd(previousEnd);
    finalEnd = previousEnd;
    previous = treatment === "baseline" ? result.channels : [input];
    previousFrameIndex = index;
    if (
      pattern === "compress-then-loss" &&
      treatment === "baseline" &&
      result.lengthChangeSamples < 0
    )
      inducedLosses.add(index + 1);
  }
  const buffer = await context.startRendering();
  const rendered = buffer.getChannelData(0);
  const active = rendered.slice(Math.round(0.14 * RATE), Math.round((finalEnd - 0.02) * RATE));
  // 出力を実際に合成した後で境界を測る。内部の境界カウンタと違い、重なりも含む。
  const boundarySteps = boundaries.map(({ at }) => {
    const position = Math.round(at * RATE);
    return Math.abs((rendered[position] ?? 0) - (rendered[position - 1] ?? 0));
  });
  cases.push({
    kind,
    pattern,
    treatment,
    requested,
    applied,
    compressedMs: scheduler.compressed * 1000,
    totalGapMs,
    concealedMs,
    failedConcealments,
    boundaryStepMax: Math.max(0, ...boundarySteps),
    frameCadenceModulationDb: envelope50(active, RATE, pattern === "target-rise" ? 1000 / 21 : 50)
      .modulationDb,
    ...summarize(active, RATE),
  });
  if (shouldRecordCase(kind, pattern, treatment, speechName))
    recordings.push({
      name: `render-${speechName === null ? kind : String(speechName)}-${pattern}-${treatment}`,
      sampleRate: RATE,
      samples: Array.from(rendered.slice(0, Math.ceil(finalEnd * RATE))),
    });
}

/** 比較対象の処理を保ち、現行だけは実セッションと同じ丸め後の位置へ接続する。 */
function joinRenderedAudio(
  treatment,
  concealmentEnd,
  decision,
  continuation,
  channels,
  missingMedia,
  previous,
) {
  const continuous =
    treatment === "current" &&
    concealmentEnd !== null &&
    concealmentEnd >= decision.startAt - 0.5 / RATE;
  const usableContinuation = treatment === "current" && !continuous ? null : continuation;
  return {
    startAt: continuous ? concealmentEnd : decision.startAt,
    output:
      usableContinuation !== null
        ? crossFadeHead(usableContinuation, channels, RATE)
        : decision.totalGapSeconds > 0 && treatment !== "no-extra-fade"
          ? fadeSpliceEdge(channels, RATE, "head")
          : treatment === "current" && missingMedia && previous !== null
            ? smoothSpliceHead(previous, channels, RATE)
            : channels,
  };
}

function shouldRecordCase(kind, pattern, treatment, speechName) {
  if (speechName !== null)
    return (
      ["baseline", "current"].includes(treatment) &&
      ["clean", "loss-voice", "target-rise", "target-fall", "compress-then-loss"].includes(pattern)
    );
  return kind === "opus" || (kind === "sine" && pattern === "target-rise");
}

export async function render(speechName = null) {
  const cases = [];
  const recordings = [];
  const opus =
    speechName === null
      ? await opusFrames()
      : await opusFrames(170, 300, await loadSpeech(speechName));
  // 欠落、正常受信、緩やかな目標移動を同じスケジューラへ通す。
  const kinds = speechName === null ? ["sine", "voiced", "opus"] : ["opus"];
  for (const kind of kinds) {
    for (const pattern of [
      "clean",
      "loss20",
      "loss-voice",
      "target-rise",
      "target-fall",
      "compress-then-loss",
    ]) {
      const treatments =
        pattern === "compress-then-loss"
          ? ["baseline", "current", "raw-conceal-reference"]
          : ["baseline", "current", "no-extra-fade", "no-compress"];
      // 対照側の圧縮直後の位置を使い、全方式へ同じ欠落列を与える。
      const inducedLosses = new Set();
      for (const treatment of treatments) {
        await renderCase(
          kind,
          pattern,
          treatment,
          opus,
          speechName,
          cases,
          recordings,
          inducedLosses,
        );
      }
    }
  }
  const resampling = [];
  for (const contextRate of [44100, 48000]) {
    const context = new OfflineAudioContext(1, contextRate * 3, contextRate);
    for (let index = 0; index < 100; index++) {
      const buffer = context.createBuffer(1, FRAME, RATE);
      buffer.getChannelData(0).fill(0.25);
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      source.start(0.12 + index * 0.02);
    }
    const rendered = await context.startRendering();
    const output = rendered.getChannelData(0);
    const active = output.slice(Math.round(0.12 * contextRate), Math.round(2.12 * contextRate));
    resampling.push({
      contextRate,
      decodedRate: RATE,
      overlapSamples: active.filter((sample) => sample > 0.375).length,
      peak: active.reduce((maximum, sample) => Math.max(maximum, sample), 0),
    });
  }
  return { speechName, opusFrames: opus.length, cases, resampling, recordings };
}

export async function speech(name) {
  return render(name);
}

/** 復号前の実 Object Datagram を欠落させ、codec の状態も含めて比較する。 */
export async function datagram(caseName) {
  const [name, pattern, copies] = caseName.split("|");
  const input = await loadSpeech(name);
  const reference = await opusFrames(170, 300, input);
  const decoded = await opusFrames(170, 300, input, { pattern, copies: Number(copies) });
  let squaredError = 0;
  let referenceEnergy = 0;
  for (const frame of decoded) {
    const original = reference[frame.packetIndex];
    if (original === undefined) throw new Error("Decoder packet correspondence changed");
    const error = frameError(frame.samples, original.samples);
    squaredError += error.squaredError;
    referenceEnergy += error.referenceEnergy;
  }
  const sparseFrames = [];
  for (const frame of decoded) sparseFrames[frame.packetIndex] = frame;
  const missing = new Set(
    Array.from({ length: 300 }, (_, index) => index).filter(
      (index) => sparseFrames[index] === undefined,
    ),
  );
  if (
    decoded.length !== decoded.transportStats.objects - decoded.transportStats.lostObjects ||
    missing.size !== decoded.transportStats.lostObjects
  )
    throw new Error("Lost Datagram positions do not match decoded output");
  const cases = [];
  const recordings = [];
  for (const treatment of ["baseline", "current"])
    await renderCase(
      "opus",
      "clean",
      treatment,
      sparseFrames,
      `${name}-${pattern}-copies${copies}`,
      cases,
      recordings,
      missing,
    );
  return {
    caseName,
    transport: decoded.transportStats,
    decodedFrames: decoded.length,
    decodedWaveformErrorDb: db(squaredError / Math.max(referenceEnergy, 1e-30)),
    cases,
    recordings,
  };
}

export async function live(caseName) {
  const frameCount = caseName.includes("long") ? 3000 : 300;
  const rate = caseName === "rate-mismatch" ? 44100 : RATE;
  const context = new AudioContext({ sampleRate: rate });
  const capture = [];
  // AudioWorklet は source の出力を直接観測する。出力のミュートより手前で収録する。
  const source = `class Capture extends AudioWorkletProcessor {
    process(inputs, outputs) {
      const channel = inputs[0]?.[0];
      this.port.postMessage({ frame: currentFrame, connected: channel !== undefined,
        samples: channel?.slice() ?? new Float32Array(outputs[0]?.[0]?.length ?? 128) });
      return true;
    }
  } registerProcessor("playout-quality-capture", Capture);`;
  const moduleUrl = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  await context.audioWorklet.addModule(moduleUrl);
  URL.revokeObjectURL(moduleUrl);
  const tap = new AudioWorkletNode(context, "playout-quality-capture");
  tap.port.onmessage = (event) => capture.push(event.data);
  const mute = context.createGain();
  mute.gain.value = 0;
  tap.connect(mute).connect(context.destination);
  const canvas = document.createElement("canvas");
  canvas.width = 16;
  canvas.height = 16;
  document.body.append(canvas);
  const drawing = canvas.getContext("2d");
  const playout = createMediaPlayout({
    audio: { context, destination: tap },
    ...(caseName.startsWith("av")
      ? {
          video: {
            output: {
              isAvailable: () => canvas.isConnected,
              present: (frame) => {
                drawing.drawImage(frame, 0, 0);
                frame.close();
                return true;
              },
            },
          },
        }
      : {}),
  });
  let decoded = null;
  if (caseName.startsWith("datagram")) {
    const [, name, pattern, copies] = caseName.split("|");
    decoded = await opusFrames(170, frameCount, await loadSpeech(name, frameCount / 50), {
      pattern,
      copies: Number(copies),
    });
  } else if (caseName.startsWith("japanese")) {
    const name = caseName.includes("julius")
      ? "julius"
      : caseName.includes("eddy")
        ? "eddy"
        : "kyoko";
    decoded = await opusFrames(170, frameCount, await loadSpeech(name, frameCount / 50));
  } else if (caseName.startsWith("voice")) {
    decoded = await opusFrames(170, 300);
  }
  await context.resume();
  const sleep = (ms) =>
    new Promise((accept) => {
      setTimeout(accept, ms);
    });
  // 初期化中の出力時計を再生開始の基準にせず、有効な観測を待つ。
  const mappingDeadline = performance.now() + 1000;
  while (!(context.getOutputTimestamp().performanceTime > 0)) {
    if (performance.now() > mappingDeadline)
      throw new Error("Output timestamp did not become available");
    await sleep(10);
  }
  await sleep(100);
  const results = [];
  const statsSeries = [];
  const origin = performance.now() + 50;
  const epoch = Math.round((performance.timeOrigin + origin) * 1000);
  const decodedByPacket =
    decoded === null ? null : new Map(decoded.map((frame) => [frame.packetIndex, frame]));
  try {
    for (let index = 0; index < frameCount; index++) {
      // 受信コールバックが 180 ms 停滞し、溜まった音が順に届く実入力を与える。
      const cycleIndex = index % 1500;
      const stall =
        caseName.endsWith("stall") && cycleIndex >= 50 && cycleIndex < 59
          ? origin + Math.floor(index / 1500) * 30000 + 1180
          : 0;
      await sleep(Math.max(0, Math.max(origin + index * 20, stall) - performance.now()));
      if (caseName === "tone-gap" && index > 0 && index % 20 === 0) continue;
      if (caseName.startsWith("datagram") && !decodedByPacket.has(index)) continue;
      const timestamp = epoch + index * 20000;
      const samples =
        decodedByPacket === null
          ? frameAt(index, RATE, 170)
          : requireAudioFrame(decodedByPacket.get(index), index, FRAME);
      const data = new AudioData({
        format: "f32-planar",
        sampleRate: RATE,
        numberOfChannels: 1,
        numberOfFrames: samples.length,
        timestamp,
        data: samples,
      });
      playout.trackAudioDecodeInput(timestamp, {
        timestampKind: "wallClock",
        inputLagMs: Math.max(0, performance.timeOrigin + performance.now() - timestamp / 1000),
      });
      const result = playout.pushAudio(data);
      data.close();
      results.push(result.status);
      if (caseName.startsWith("av") && index % 2 === 0) {
        const frame = new VideoFrame(canvas, { timestamp });
        playout.trackVideoDecodeInput(timestamp, {
          timestampKind: "wallClock",
          location: { group: BigInt(index / 2), object: 0n },
        });
        playout.pushVideo(frame);
      }
      if (index % 25 === 0) statsSeries.push({ index, stats: playout.getStats() });
    }
    await playout.drainAudio({ maxWaitMs: 500 });
    await sleep(100);
    const stats = playout.getStats();
    await context.suspend();
    // currentFrame に重複があるブラウザでも、届いた PCM を上書きしたり無音を挿入しない。
    // 収録順で連結し、時計の異常は別の診断値へ残す。
    const samples = new Float32Array(capture.reduce((sum, block) => sum + block.samples.length, 0));
    let position = 0;
    for (const block of capture) {
      samples.set(block.samples, position);
      position += block.samples.length;
    }
    const firstActive = samples.findIndex((sample) => Math.abs(sample) > 1e-5);
    let end = samples.length;
    while (end > 0 && Math.abs(samples[end - 1] ?? 0) <= 1e-5) end--;
    const active = samples.slice(firstActive, end);
    const captureGaps = capture.slice(1).flatMap((block, index) => {
      const previous = capture[index];
      const missingFrames = block.frame - previous.frame - previous.samples.length;
      return missingFrames === 0 ? [] : [{ frame: block.frame, missingFrames }];
    });
    return {
      caseName,
      transport: caseName.startsWith("datagram") ? decoded.transportStats : null,
      contextRate: rate,
      inputRate: RATE,
      results,
      statsSeries,
      stats,
      capturedSamples: samples.length,
      captureGaps,
      activeSamples: active.length,
      metrics: summarize(active, rate),
      recordings: [{ name: `live-${caseName}`, sampleRate: rate, samples: Array.from(active) }],
    };
  } finally {
    playout.clearAll();
    playout.setAudioOutput(null);
    tap.disconnect();
    mute.disconnect();
    canvas.remove();
    await context.close();
  }
}

export async function long(caseName) {
  return live(caseName);
}

export async function datagramLive(caseName) {
  return live(caseName);
}

/** 実リレー、実高レベル API、実 MediaStream 出力を通す。損失だけを受信境界で注入する。 */
export async function relay(caseName, relayUrl) {
  if (!relayUrl) throw new Error("PLAYOUT_RELAY_URI is required for relay measurement");
  const { createMediaPublisher } = await import("../src/createMediaPublisher.ts");
  const { createMediaSubscriber } = await import("../src/createMediaSubscriber.ts");
  const { playoutAudioSchedulerOf } = await import("../src/testSupport/mediaPlayoutInternals.ts");
  const [, name, pattern, copies] = caseName.split("|");
  const context = new AudioContext({ sampleRate: RATE });
  const destination = context.createMediaStreamDestination();
  const buffer = context.createBuffer(1, RATE * 6, RATE);
  buffer.copyToChannel(await loadSpeech(name), 0);
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.loop = true;
  source.connect(destination);
  const namespace = ["playout-quality", crypto.randomUUID()];
  const errors = [];
  const callbacks = { onError: (error) => errors.push(error.message) };
  const publisher = await createMediaPublisher(
    relayUrl,
    {
      namespace,
      useWorker: true,
      audio: {
        codec: "opus",
        bitrate: 64000,
        channels: 1,
        delivery: "datagram",
        redundancy: Number(copies),
      },
    },
    callbacks,
  );
  const subscriber = await createMediaSubscriber(
    relayUrl,
    { namespace, useWorker: true, audio: {} },
    callbacks,
  );
  const receive = subscriber.receiveAudioObject.bind(subscriber);
  // 同じ実到着列で待ちの深さだけを変えるため、実復号出力と scheduler の入力を記録する。
  const trace = [];
  let decodedChannels = [];
  const handleDecoded = subscriber.handleAudioDecodedData.bind(subscriber);
  subscriber.handleAudioDecodedData = (output) => {
    decodedChannels = Array.from({ length: output.data.numberOfChannels }, (_, planeIndex) => {
      const samples = new Float32Array(output.data.numberOfFrames);
      output.data.copyTo(samples, { planeIndex, format: "f32-planar" });
      return samples;
    });
    handleDecoded(output);
  };
  const scheduler = playoutAudioSchedulerOf(subscriber.playout);
  const schedule = scheduler.schedule.bind(scheduler);
  scheduler.schedule = (now, timestamp, duration, target) => {
    trace.push({ now, timestamp, duration, target, channels: decodedChannels });
    return schedule(now, timestamp, duration, target);
  };
  /** @type {bigint | null} 最初に観測した Group の位置 */
  let firstGroup = null;
  let randomState = 0x74219;
  let packets = 0;
  let droppedPackets = 0;
  const droppedGroups = new Set();
  const deliveredGroups = new Set();
  // 出力や通信を代替しない。実 QUIC で届いた音声 Object の一部だけを復号前で落とす。
  subscriber.receiveAudioObject = (
    /** @type {import("../src/dataStream").MoqtObject} */ object,
    delivery,
  ) => {
    if (delivery === "datagram") {
      packets++;
      firstGroup ??= object.groupId;
      const index = Number(object.groupId - firstGroup);
      randomState = (randomState * 1664525 + 1013904223) >>> 0;
      const randomLoss =
        pattern.startsWith("random") && randomState / 4294967296 < Number(pattern.slice(6)) / 100;
      const burstLength = pattern.startsWith("burst") ? Number(pattern.slice(5)) : 0;
      const burstLoss = burstLength > 0 && index % 50 >= 20 && index % 50 < 20 + burstLength;
      if (randomLoss || burstLoss) {
        droppedPackets++;
        droppedGroups.add(object.groupId.toString());
        return;
      }
      deliveredGroups.add(object.groupId.toString());
    }
    receive(object, delivery);
  };
  let reader = null;
  let captureTask = null;
  const capture = [];
  const statsSeries = [];
  let capturedFormat = null;
  const sleep = (ms) =>
    new Promise((accept) => {
      setTimeout(accept, ms);
    });
  try {
    await context.resume();
    source.start();
    await publisher.start(destination.stream);
    await subscriber.start();
    const track = subscriber.mediaStream?.getAudioTracks()[0];
    if (track === undefined) throw new Error("Relay audio output track is unavailable");
    const processor = new MediaStreamTrackProcessor({ track });
    reader = processor.readable.getReader();
    captureTask = (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        capturedFormat ??= { sampleRate: value.sampleRate, channels: value.numberOfChannels };
        const samples = new Float32Array(value.numberOfFrames);
        value.copyTo(samples, { planeIndex: 0, format: "f32-planar" });
        capture.push(samples);
        value.close();
      }
    })();
    for (let second = 0; second < 20; second++) {
      await sleep(1000);
      statsSeries.push({
        second: second + 1,
        subscriber: subscriber.getStats(),
        publisher: publisher.getStats(),
        playout: subscriber.playout.getStats(),
      });
    }
    const stats = subscriber.getStats();
    const publisherStats = publisher.getStats();
    await subscriber.stop();
    const afterStop = subscriber.getStats();
    await reader.cancel();
    await captureTask;
    const samples = new Float32Array(capture.reduce((sum, block) => sum + block.length, 0));
    let offset = 0;
    for (const block of capture) {
      samples.set(block, offset);
      offset += block.length;
    }
    let inputFrameStepMax = 0;
    for (const frame of trace) {
      const channel = frame.channels[0];
      if (channel === undefined) continue;
      for (let index = 1; index < channel.length; index++)
        inputFrameStepMax = Math.max(
          inputFrameStepMax,
          Math.abs(channel[index] - channel[index - 1]),
        );
    }
    if (samples.length < RATE * 19 || (stats.audio?.datagramFramesReceived ?? 0) < 500)
      throw new Error("Relay did not produce the required measured audio");
    return {
      caseName,
      seconds: samples.length / RATE,
      errors,
      packets,
      droppedPackets,
      lostGroups: [...droppedGroups].filter((group) => !deliveredGroups.has(group)).length,
      statsSeries,
      stats,
      afterStop,
      publisherStats,
      capturedFormat,
      inputFrameStepMax,
      budgetReplay: [50, 80, 100, 140].map((budgetMs) => replayArrivalTrace(trace, budgetMs)),
      arrivalTrace: trace.map(({ channels, ...entry }) => ({
        ...entry,
        channels: channels.map((channel) => Array.from(channel)),
      })),
      metrics: summarize(samples, RATE),
      recordings: [{ name: caseName, sampleRate: RATE, samples: Array.from(samples) }],
    };
  } catch (error) {
    throw new Error(`Relay measurement failed: ${errors.join("; ")}`, { cause: error });
  } finally {
    if (reader !== null) await reader.cancel().catch(() => {});
    if (captureTask !== null) await captureTask.catch(() => {});
    await Promise.allSettled([subscriber.close(), publisher.close()]);
    source.stop();
    destination.stream.getTracks().forEach((track) => track.stop());
    await context.close();
  }
}

/** 実リレーで観測した同一の入力を、実 scheduler と実 DSP へ待ちとキューの条件を変えて再投入する。 */
function replayArrivalTrace(trace, budgetMs, backlogSeconds) {
  const scheduler = new AudioPlayoutScheduler(
    backlogSeconds === undefined ? {} : { backlogSeconds },
  );
  const delays = [];
  let previous = null;
  let uncoveredMs = 0;
  let totalGapMs = 0;
  let compressedMs = 0;
  let rejectedCompression = 0;
  let drops = 0;
  for (const frame of trace) {
    const decision = scheduler.schedule(frame.now, frame.timestamp, frame.duration, {
      ...frame.target,
      enforceTarget: false,
      arrivalDelaySeconds: budgetMs / 1000,
    });
    if (decision.kind !== "play") {
      drops++;
      continue;
    }
    const result =
      decision.compressSeconds > 0
        ? compressSamples(frame.channels, RATE, Math.round(decision.compressSeconds * RATE))
        : { channels: frame.channels, lengthChangeSamples: 0 };
    scheduler.confirmStretch(-result.lengthChangeSamples / RATE);
    compressedMs += (-result.lengthChangeSamples / RATE) * 1000;
    if (decision.compressSeconds > 0 && result.lengthChangeSamples === 0) rejectedCompression++;
    let concealedSeconds = 0;
    if (previous !== null && decision.gapSeconds > 0) {
      const concealed = concealSamples(
        previous,
        RATE,
        decision.gapSeconds + 0.002,
        concealmentEndGain(decision.gapSeconds),
      );
      if (concealed.generatedSamples > 0)
        concealedSeconds = Math.min(
          concealed.generatedSamples / RATE,
          Math.round(decision.gapSeconds * RATE) / RATE,
        );
      else if (decision.gapSeconds <= 0.002)
        concealedSeconds = Math.round(decision.gapSeconds * RATE) / RATE;
    }
    scheduler.confirmConcealment(concealedSeconds);
    totalGapMs += decision.totalGapSeconds * 1000;
    uncoveredMs += Math.max(0, decision.totalGapSeconds - concealedSeconds) * 1000;
    delays.push((decision.startAt - frame.target.arrivalSeconds) * 1000);
    previous = frame.channels;
  }
  return {
    budgetMs,
    ...(backlogSeconds === undefined ? {} : { backlogMs: backlogSeconds * 1000 }),
    frames: trace.length,
    drops,
    totalGapMs,
    uncoveredMs,
    compressedMs,
    rejectedCompression,
    delayP50Ms: percentile(delays, 0.5),
    delayP95Ms: percentile(delays, 0.95),
    delayMaxMs: Math.max(0, ...delays),
  };
}

/** 予約できる最早時刻とキューの余裕を、保存した同一の到着列で切り分ける。 */
export function replay(savedTrace) {
  const trace = savedTrace.map((frame) => ({
    ...frame,
    channels: frame.channels.map((channel) => Float32Array.from(channel)),
  }));
  const earliest = trace.map(
    (frame) => (frame.now + AUDIO_PLAYOUT_MIN_LEAD_SECONDS - frame.target.arrivalSeconds) * 1000,
  );
  return {
    frames: trace.length,
    // currentTime と出力時計の対応を含む予約の下限であり、機器の物理遅延ではない。
    earliestDelayP50Ms: percentile(earliest, 0.5),
    earliestDelayP95Ms: percentile(earliest, 0.95),
    earliestDelayMaxMs: Math.max(0, ...earliest),
    budgetReplay: [50, 80, 100, 140].map((budgetMs) => replayArrivalTrace(trace, budgetMs)),
    // 既存の backlog 判定の余裕だけを短縮する対照。採用する前に音の棄却と待ちを測る。
    backlogReplay: [0, 0.02, 0.05].map((seconds) => replayArrivalTrace(trace, 50, seconds)),
  };
}
