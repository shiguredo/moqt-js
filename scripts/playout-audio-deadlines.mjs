/** 保存した同じ復号 PCM と到着列で、予約、実出力、独立した再描画を照合する。 */
import { watchProcessorErrors } from "./playout-measurement-guards.mjs";
import { analyseReservationCoverage, comparePcmSamples } from "./playout-reservation-analysis.mjs";

const sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
async function waitUntil(condition, label) {
  const deadline = performance.now() + 8000;
  while (!condition()) {
    if (performance.now() > deadline) throw new Error(`Timed out: ${label}`);
    await sleep(5);
  }
}

function distribution(values) {
  const ordered = values.toSorted((left, right) => left - right);
  const at = (fraction) =>
    ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * fraction))] ?? null;
  return { count: ordered.length, p50: at(0.5), p95: at(0.95), max: ordered.at(-1) ?? null };
}

/** 実メソッドへ必ず委譲し、判断に使った時計と実際のバッファだけを採取する。 */
function observeReservations(playout, context) {
  const session = playout.audio.session;
  if (typeof session.connectWithEnvelope !== "function")
    throw new Error(
      "Deadline reconstruction requires the saved arrival-scheduled source: use the WebRTC PCM comparison for render-side playout",
    );
  const events = [];
  const reservations = [];
  const attempts = [];
  const phase = { scheduling: false };
  const schedule = session.playout.schedule.bind(session.playout);
  session.playout.schedule = (now, timestamp, duration, target) => {
    const previousEnd = session.playout.lastEnd;
    phase.scheduling = true;
    const decision = schedule(now, timestamp, duration, target);
    phase.scheduling = false;
    events.push({
      now,
      timestamp,
      duration,
      target: { ...target },
      previousEnd,
      decision: { ...decision },
    });
    return decision;
  };
  for (const [method, field] of [
    ["confirmStretch", "appliedStretchSeconds"],
    ["confirmConcealment", "appliedConcealSeconds"],
    ["confirmPlayoutEnd", "finalEndSeconds"],
  ]) {
    const original = session.playout[method].bind(session.playout);
    session.playout[method] = (value) => {
      if (!phase.scheduling) events.at(-1)[field] = value;
      return original(value);
    };
  }
  const connect = session.connectWithEnvelope.bind(session);
  session.connectWithEnvelope = (output, source, start, duration, rate) => {
    const previous = session.lastScheduledEnvelope;
    const observedAtSeconds = context.currentTime;
    connect(output, source, start, duration, rate);
    const headFade = session.lastScheduledEnvelope.gain.gain.value === 0;
    const contiguous = previous !== null && Math.abs(start - previous.endSeconds) <= 0.5 / rate;
    if (contiguous && !headFade && reservations.length > 0)
      reservations.at(-1).tailCancelled = true;
    reservations.push({
      startSeconds: start,
      endSeconds: start + duration,
      observedAtSeconds,
      headFade,
      tailCancelled: false,
      sampleRate: rate,
      buffer: source.buffer,
      eventIndex: events.length - 1,
    });
  };
  const conceal = session.concealGap.bind(session);
  session.concealGap = (channels, rate, seconds, endGain) => {
    const result = conceal(channels, rate, seconds, endGain);
    attempts.push({
      eventIndex: events.length - 1,
      sampleRate: rate,
      requestedSeconds: seconds,
      endGain,
      previousSamples: channels[0].length,
      historySamples: session.concealmentHistory.channels[0]?.length ?? 0,
      generatedSamples: result.generatedSamples,
    });
    return result;
  };
  return { events, reservations, attempts };
}

/** 波形の値と独立した信号で、バッファが鳴る区間そのものを収録する。 */
function markCoverage(context, destination, buffer, start, end) {
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.loop = true;
  source.connect(destination);
  source.start(start);
  source.stop(end);
  source.onended = () => source.disconnect();
  return start < context.currentTime;
}

async function createCapture(context, blocks) {
  const url = URL.createObjectURL(
    new Blob(
      [
        `class Capture extends AudioWorkletProcessor {
    process(inputs) {
      this.frames ??= 0;
      this.port.postMessage({frame:this.frames,renderFrame:currentFrame,channels:inputs.map(input=>input[0]?.slice()??new Float32Array(128))});
      this.frames+=128;return true;
    }
  } registerProcessor('deadline-capture',Capture);`,
      ],
      { type: "text/javascript" },
    ),
  );
  try {
    await context.audioWorklet.addModule(url);
  } finally {
    URL.revokeObjectURL(url);
  }
  const tap = new AudioWorkletNode(context, "deadline-capture", {
    numberOfInputs: 5,
    numberOfOutputs: 1,
    outputChannelCount: [1],
  });
  const errors = watchProcessorErrors(tap);
  tap.port.onmessage = (event) => blocks.push(event.data);
  tap.connect(context.destination);
  return { tap, errors };
}

/** 描画時計の表示の飛びと、収録メッセージの欠落を混同しない。 */
function joinBlocks(blocks) {
  const count = blocks.reduce((sum, block) => sum + block.channels[0].length, 0);
  const channels = Array.from({ length: 5 }, () => new Float32Array(count));
  let offset = 0;
  let missing = 0;
  let clockAnomalies = 0;
  for (const [index, block] of blocks.entries()) {
    if (index > 0) {
      if (block.frame !== blocks[index - 1].frame + 128) missing++;
      if (block.renderFrame !== blocks[index - 1].renderFrame + 128) clockAnomalies++;
    }
    for (let channel = 0; channel < 5; channel++)
      channels[channel].set(block.channels[channel], offset);
    offset += 128;
  }
  return { channels, missing, clockAnomalies, firstFrame: blocks[0]?.renderFrame ?? 0 };
}

/** 採取したバッファと実際に適用された envelope から、別の実レンダラーで出力を再構成する。 */
async function renderOffline(reservations, rate, count, firstFrame) {
  const context = new OfflineAudioContext(1, count, rate);
  for (const reservation of reservations) {
    const { startSeconds, endSeconds, buffer } = reservation;
    const offset = firstFrame / rate;
    const source = context.createBufferSource();
    source.buffer = buffer;
    const gain = context.createGain();
    source.connect(gain).connect(context.destination);
    const fade = Math.min(0.002, (endSeconds - startSeconds) / 2);
    const headEnd = startSeconds + fade - offset;
    if (reservation.headFade) {
      gain.gain.value = 0;
      gain.gain.setValueAtTime(0, startSeconds - offset);
      gain.gain.linearRampToValueAtTime(1, headEnd);
    }
    if (!reservation.tailCancelled) {
      gain.gain.setValueAtTime(1, Math.max(headEnd, endSeconds - offset - fade));
      gain.gain.linearRampToValueAtTime(0, endSeconds - offset);
    }
    source.start(startSeconds - offset);
    source.stop(endSeconds - offset);
  }
  const rendered = await context.startRendering();
  return rendered.getChannelData(0).slice();
}

/** 実スケジューラーへ同じ引数と確定値を戻し、採取した判断が再現することも検査する。 */
function replayScheduler(AudioPlayoutScheduler, trace) {
  const scheduler = new AudioPlayoutScheduler();
  const mismatches = [];
  for (const [index, event] of trace.events.entries()) {
    const decision = scheduler.schedule(event.now, event.timestamp, event.duration, event.target);
    if (JSON.stringify(decision) !== JSON.stringify(event.decision)) mismatches.push(index);
    scheduler.confirmStretch(event.appliedStretchSeconds);
    scheduler.confirmConcealment(event.appliedConcealSeconds);
    scheduler.confirmPlayoutEnd(event.finalEndSeconds);
  }
  return mismatches;
}

async function analyse(
  context,
  playout,
  trace,
  blocks,
  reference,
  marker,
  markerStart,
  coverageLate,
  deliveries,
  moduleUrl,
) {
  const capture = joinBlocks(blocks);
  const rate = context.sampleRate;
  const waveform = await renderOffline(
    trace.reservations,
    rate,
    capture.channels[0].length,
    capture.firstFrame,
  );
  const referenceWave = await renderOffline(
    reference,
    rate,
    capture.channels[0].length,
    capture.firstFrame,
  );
  const markerWave = await renderOffline(
    [
      {
        startSeconds: markerStart,
        endSeconds: markerStart + marker.duration,
        buffer: marker,
        headFade: false,
        tailCancelled: true,
      },
    ],
    rate,
    capture.channels[0].length,
    capture.firstFrame,
  );
  const waveformComparison = comparePcmSamples(capture.channels[1], waveform);
  const referenceComparison = comparePcmSamples(capture.channels[3], referenceWave);
  const markerComparison = comparePcmSamples(capture.channels[0], markerWave);
  const coverage = analyseReservationCoverage({
    reservations: trace.reservations,
    samples: capture.channels[1],
    coverage: capture.channels[2],
    sampleRate: rate,
    firstFrame: capture.firstFrame,
  });
  const { AudioPlayoutScheduler } = await import(new URL("./audioPlayout.ts", moduleUrl).href);
  const schedulerMismatches = replayScheduler(AudioPlayoutScheduler, trace);
  const stats = playout.getStats().audio;
  return {
    firstFrame: capture.firstFrame,
    capturedSamples: capture.channels[0].length,
    branchNames: ["marker", "current", "coverage", "decoded", "decoded-coverage"],
    coverage,
    waveformComparison,
    referenceComparison,
    markerComparison,
    schedulerMismatches,
    captureMissing: capture.missing,
    clockAnomalies: capture.clockAnomalies,
    coverageLate,
    stats,
    deliveryLatenessMs: distribution(deliveries.map((event) => event.actualMs - event.requestedMs)),
    processingMs: distribution(deliveries.map((event) => event.processingMs)),
    trace: {
      events: trace.events,
      attempts: trace.attempts,
      reservations: trace.reservations.map(({ buffer, ...reservation }) => ({
        ...reservation,
        channels: buffer.numberOfChannels,
        frames: buffer.length,
        samples: Array.from(buffer.getChannelData(0)),
      })),
    },
    valid:
      capture.missing === 0 &&
      coverageLate === 0 &&
      schedulerMismatches.length === 0 &&
      waveformComparison.differingSamples === 0 &&
      referenceComparison.differingSamples === 0 &&
      markerComparison.differingSamples === 0 &&
      coverage.coverageMismatchSamples === 0 &&
      coverage.truncatedReservationSamples === 0 &&
      coverage.gaps.every((gap) => gap.nonzeroInteriorSamples === 0),
    recordings: [
      ...capture.channels.map((samples, index) => ({
        name: `input-${index}`,
        samples: Array.from(samples),
        sampleRate: rate,
        saveFloat32: true,
      })),
      { name: "reconstructed", samples: Array.from(waveform), sampleRate: rate, saveFloat32: true },
    ],
  };
}

export async function measure(caseName, { moduleUrl, audioTrace }) {
  const [, rateString, , mode] = caseName.split("|");
  const withVideo = mode === "av";
  const rate = Number(rateString);
  if (![44100, 48000].includes(rate)) throw new Error(`Invalid output rate: ${rate}`);
  if (!audioTrace?.frames?.length) throw new Error("A decoded PCM arrival trace is required");
  const { createMediaPlayout } = await import(moduleUrl);
  const context = new AudioContext({ sampleRate: rate, latencyHint: "interactive" });
  await context.suspend();
  const blocks = [];
  let playout;
  let video = null;
  try {
    video = withVideo ? prepareVideo() : null;
    const { tap, errors } = await createCapture(context, blocks);
    const destination = context.createGain();
    destination.connect(tap, 0, 1);
    const coverageDestination = context.createGain();
    coverageDestination.connect(tap, 0, 2);
    const referenceCoverage = context.createGain();
    referenceCoverage.connect(tap, 0, 4);
    const ones = context.createBuffer(1, 128, rate);
    ones.getChannelData(0).fill(1);
    const traceSeconds = audioTrace.frames.at(-1).atMs / 1000;
    const marker = context.createBuffer(1, Math.ceil((traceSeconds + 2) * rate), rate);
    const markerSamples = marker.getChannelData(0);
    for (let index = 0; index < markerSamples.length; index++)
      markerSamples[index] = -0.25 + (0.5 * index) / markerSamples.length;
    const markerSource = context.createBufferSource();
    markerSource.buffer = marker;
    markerSource.connect(tap, 0, 0);
    playout = createMediaPlayout({
      audio: { context, destination },
      ...(video === null ? {} : { video: video.options }),
    });
    const trace = observeReservations(playout, context);
    const reference = [];
    const deliveries = [];
    await context.resume();
    await waitUntil(() => context.getOutputTimestamp().performanceTime > 0, "output clock");
    await sleep(100);
    const originMs = performance.now() + 100;
    const epoch = Math.round((performance.timeOrigin + originMs) * 1000);
    const firstTimestamp = audioTrace.frames[0].timestamp;
    const markerStart = context.currentTime + 0.05;
    markerSource.start(markerStart);
    let referenceEnd = null;
    let coverageLate = 0;
    for (const delivery of arrivalEvents(audioTrace.frames, withVideo)) {
      const requestedMs = originMs + delivery.atMs;
      const remaining = requestedMs - performance.now();
      if (remaining > 0) await sleep(remaining);
      if (delivery.kind === "video") {
        video.paint.fillStyle = `rgb(${delivery.index % 256},100,180)`;
        video.paint.fillRect(0, 0, 32, 32);
        const frame = new VideoFrame(video.input, {
          timestamp: epoch + Math.round((delivery.index * 1000000) / 30),
        });
        playout.trackVideoDecodeInput(frame.timestamp, {
          timestampKind: "wallClock",
          location: { group: BigInt(delivery.index), object: 0n },
        });
        playout.pushVideo(frame);
        video.delivered++;
        continue;
      }
      const index = delivery.index;
      const frame = audioTrace.frames[index];
      const timestamp = withVideo ? epoch + frame.timestamp - firstTimestamp : frame.timestamp;
      const samples = Float32Array.from(frame.samples);
      const data = new AudioData({
        format: "f32-planar",
        sampleRate: 48000,
        numberOfChannels: 1,
        numberOfFrames: samples.length,
        timestamp,
        data: samples,
      });
      const firstReservation = trace.reservations.length;
      const actualMs = performance.now();
      playout.trackAudioDecodeInput(timestamp, {
        timestampKind: withVideo ? "wallClock" : "mediaTime",
      });
      let result;
      try {
        result = playout.pushAudio(data);
      } finally {
        data.close();
      }
      const processingMs = performance.now() - actualMs;
      if (result.status !== "played")
        throw new Error(`Audio did not play at frame ${index}: ${result.status}`);
      for (
        let reservationIndex = firstReservation;
        reservationIndex < trace.reservations.length;
        reservationIndex++
      ) {
        const reservation = trace.reservations[reservationIndex];
        reservation.kind =
          reservationIndex === trace.reservations.length - 1 ? "real" : "concealment";
        if (
          markCoverage(
            context,
            coverageDestination,
            ones,
            reservation.startSeconds,
            reservation.endSeconds,
          )
        )
          coverageLate++;
      }
      const buffer = context.createBuffer(1, samples.length, 48000);
      buffer.copyToChannel(samples, 0);
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(tap, 0, 3);
      referenceEnd ??= context.currentTime + 0.2;
      const end = referenceEnd + samples.length / 48000;
      reference.push({
        startSeconds: referenceEnd,
        endSeconds: end,
        buffer,
        headFade: false,
        tailCancelled: true,
      });
      if (markCoverage(context, referenceCoverage, ones, referenceEnd, end)) coverageLate++;
      source.start(referenceEnd);
      source.stop(end);
      source.onended = () => source.disconnect();
      referenceEnd = end;
      deliveries.push({
        index,
        requestedMs,
        actualMs,
        processingMs,
        contextAfterSeconds: context.currentTime,
      });
    }
    await waitUntil(
      () =>
        context.currentTime >= Math.max(referenceEnd, trace.reservations.at(-1).endSeconds) + 0.05,
      "output drain",
    );
    await context.suspend();
    await sleep(50);
    const result = await analyse(
      context,
      playout,
      trace,
      blocks,
      reference,
      marker,
      markerStart,
      coverageLate,
      deliveries,
      moduleUrl,
    );
    return {
      ...result,
      valid:
        result.valid &&
        errors.length === 0 &&
        (video === null ||
          (video.presentations.length > audioTrace.frames.length / 2 &&
            video.delivered === video.presentations.length + video.lateDrops + video.queueDrops)),
      videoPresentations: video?.presentations ?? null,
      videoCoverage:
        video === null
          ? null
          : {
              delivered: video.delivered,
              presented: video.presentations.length,
              lateDrops: video.lateDrops,
              queueDrops: video.queueDrops,
            },
      errors,
      deliveries,
      rate,
      recordings: result.recordings.map((recording) => ({
        ...recording,
        name: `${caseName}-${recording.name}`,
      })),
    };
  } finally {
    playout?.clearAll();
    video?.input.remove();
    video?.output.remove();
    await context.close();
  }
}

/** 映像の到着は一定周期の対照条件とし、音声の実測到着列とは区別する。 */
function arrivalEvents(frames, withVideo) {
  const events = frames.map((frame, index) => ({ kind: "audio", index, atMs: frame.atMs }));
  if (withVideo)
    for (let index = 0; (index * 1000) / 30 <= frames.at(-1).atMs; index++)
      events.push({ kind: "video", index, atMs: (index * 1000) / 30 });
  return events.sort((left, right) => left.atMs - right.atMs);
}

/** 表示の代用品は使わず、実 canvas へ描画されたフレームだけを数える。 */
function prepareVideo() {
  const input = document.createElement("canvas");
  const output = document.createElement("canvas");
  input.width = 32;
  input.height = 32;
  output.width = 32;
  output.height = 32;
  document.body.append(input, output);
  const paint = input.getContext("2d");
  const drawing = output.getContext("2d");
  const presentations = [];
  const state = {
    input,
    output,
    paint,
    presentations,
    delivered: 0,
    lateDrops: 0,
    queueDrops: 0,
    options: {
      pacing: { drainImmediately: false, framesPerDrain: 1 },
      timing: {
        recordLateDrop: () => state.lateDrops++,
        recordQueueDrop: () => state.queueDrops++,
      },
      output: {
        isAvailable: () => output.isConnected,
        present: (frame, plannedMs) => {
          drawing.drawImage(frame, 0, 0);
          presentations.push({ timestamp: frame.timestamp, atMs: performance.now(), plannedMs });
          frame.close();
          return true;
        },
      },
    },
  };
  return state;
}
