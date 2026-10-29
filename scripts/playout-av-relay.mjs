/** 実 QUIC Datagram、Worker 復号、実音声と canvas で A/V を測る。 */
import { loadSpeech } from "./playout-audio-input.mjs";

import { hasAvCoverage } from "./playout-measurement-guards.mjs";

const RATE = 48000;
const sleep = (ms) =>
  new Promise((accept) => {
    setTimeout(accept, ms);
  });

function distribution(values) {
  const sorted = values
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => left - right);
  const percentile = (fraction) =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? null;
  return {
    samples: sorted.length,
    p50: percentile(0.5),
    p95: percentile(0.95),
    max: sorted.at(-1) ?? null,
  };
}

/** 同一の実 MediaStream を配信し、計測後に解放できるよう出力をまとめる。 */
async function prepareSource(name) {
  const context = new AudioContext({ sampleRate: RATE });
  const destination = context.createMediaStreamDestination();
  const buffer = context.createBuffer(1, RATE * 6, RATE);
  buffer.copyToChannel(await loadSpeech(name), 0);
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.loop = true;
  source.connect(destination);
  const inputCanvas = document.createElement("canvas");
  const outputCanvas = document.createElement("canvas");
  inputCanvas.width = 320;
  outputCanvas.width = 320;
  inputCanvas.height = 180;
  outputCanvas.height = 180;
  document.body.append(inputCanvas, outputCanvas);
  const paint = inputCanvas.getContext("2d");
  const drawing = outputCanvas.getContext("2d");
  let paintedFrames = 0;
  const paintFrame = () => {
    paint.fillStyle = `rgb(${paintedFrames++ % 256}, 100, 180)`;
    paint.fillRect(0, 0, 320, 180);
  };
  paintFrame();
  const paintTimer = setInterval(paintFrame, 1000 / 30);
  const videoStream = inputCanvas.captureStream(30);
  const stream = new MediaStream([...destination.stream.getTracks(), ...videoStream.getTracks()]);
  return { context, destination, source, stream, inputCanvas, outputCanvas, drawing, paintTimer };
}

/** 収録自体の欠けを分離し、連続して得られた波形の段差を測る。 */
function summarizeCapture(capture) {
  const samples = new Float32Array(capture.reduce((sum, block) => sum + block.samples.length, 0));
  let offset = 0;
  let stepMax = 0;
  let captureMissingMs = 0;
  let captureMaxGapMs = 0;
  let previousCapture = null;
  const captureFrames = [];
  for (const block of capture) {
    const gapFrames = previousCapture === null ? 0 : block.frame - previousCapture.endFrame;
    const gapMicros = (gapFrames * 1000000) / RATE;
    if (gapMicros > 1) {
      captureMissingMs += gapMicros / 1000;
      captureMaxGapMs = Math.max(captureMaxGapMs, gapMicros / 1000);
    }
    // 実サンプル位置が欠けた境界を、再生波形のクリックと誤認しない。
    if (previousCapture !== null && Math.abs(gapMicros) <= 1)
      stepMax = Math.max(stepMax, Math.abs(block.samples[0] - previousCapture.tail));
    for (let index = 1; index < block.samples.length; index++)
      stepMax = Math.max(stepMax, Math.abs(block.samples[index] - block.samples[index - 1]));
    samples.set(block.samples, offset);
    offset += block.samples.length;
    previousCapture = {
      endFrame: block.frame + block.samples.length,
      tail: block.samples.at(-1),
    };
    captureFrames.push({
      frame: block.frame,
      renderFrame: block.renderFrame,
      sequence: block.sequence,
      frames: block.samples.length,
      gapMicros,
    });
  }
  return { samples, stepMax, captureMissingMs, captureMaxGapMs, captureFrames };
}

/** 実出力の AudioContext へ pass-through の収録点を付け、サンプル位置も記録する。 */
async function captureOutput(subscriber, capture) {
  const output = subscriber.playout.audioOutput;
  if (!output || output.context.sampleRate !== RATE)
    throw new Error("A 48000 Hz relay audio output is required");
  const url = URL.createObjectURL(
    new Blob(
      [
        `class RelayCapture extends AudioWorkletProcessor {
      process(inputs, outputs) {
        const channel = outputs[0][0];
        if (inputs[0]?.[0]) channel.set(inputs[0][0]);
        this.frames ??= 0;
        this.sequence ??= 0;
        this.port.postMessage({samples: channel.slice(), frame: this.frames, renderFrame: currentFrame, sequence: this.sequence++});
        this.frames += channel.length;
        return true;
      }
    } registerProcessor("relay-av-capture", RelayCapture);`,
      ],
      { type: "text/javascript" },
    ),
  );
  try {
    await output.context.audioWorklet.addModule(url);
  } finally {
    URL.revokeObjectURL(url);
  }
  const tap = new AudioWorkletNode(output.context, "relay-av-capture");
  tap.port.onmessage = (event) => capture.push(event.data);
  tap.connect(output.destination);
  // 同じ Context の出力先だけを公開 API で差し替え、時計と媒体の観測は保つ。
  // 測定の開始前に接続し、その後の最初の 1 秒も分布から除く。
  subscriber.playout.setAudioOutput({ context: output.context, destination: tap });
  return tap;
}

export async function measure(
  caseName,
  { moduleUrl, variant, seconds, relayUrl, certificateHash },
) {
  if (!relayUrl) throw new Error("PLAYOUT_RELAY_URI is required for A/V relay measurement");
  const { createMediaPublisher } = await import(
    new URL("../createMediaPublisher.ts", moduleUrl).href
  );
  const { createMediaSubscriber } = await import(
    new URL("../createMediaSubscriber.ts", moduleUrl).href
  );
  const [, name, pattern, copies] = caseName.split("|");
  // 開発用の証明書を使う実リレーだけ、明示された公開ハッシュを渡す。
  const certificateOptions = certificateHash
    ? {
        serverCertificateHashes: [
          Uint8Array.from(atob(certificateHash), (character) => character.charCodeAt(0)).buffer,
        ],
      }
    : {};
  const { context, source, stream, inputCanvas, outputCanvas, drawing, paintTimer } =
    await prepareSource(name);
  const namespace = ["playout-av-quality", crypto.randomUUID()];
  const errors = [];
  const states = [];
  const callbacks = (role) => ({
    onError: (error) => errors.push({ role, message: error.message, atMs: performance.now() }),
    onStateChange: (state) => states.push({ role, state, atMs: performance.now() }),
  });
  const publisher = await createMediaPublisher(
    relayUrl,
    {
      namespace,
      useWorker: true,
      ...certificateOptions,
      audio: {
        codec: "opus",
        bitrate: 64000,
        channels: 1,
        delivery: "datagram",
        redundancy: Number(copies),
      },
      video: { codec: "vp8", bitrate: 300000, width: 320, height: 180, framerate: 30 },
    },
    callbacks("publisher"),
  );
  const subscriber = await createMediaSubscriber(
    relayUrl,
    {
      namespace,
      useWorker: true,
      audio: {},
      video: {},
      ...certificateOptions,
    },
    callbacks("subscriber"),
  );
  const audio = [];
  const video = [];
  let inputStepMax = 0;
  let previousInput = null;
  const pushAudio = subscriber.playout.pushAudio.bind(subscriber.playout);
  // 実 API の前後を記録するだけで、復号、予約、所有権の処理を置き換えない。
  subscriber.playout.pushAudio = (data, ...args) => {
    const samples = new Float32Array(data.numberOfFrames);
    data.copyTo(samples, { planeIndex: 0, format: "f32-planar" });
    for (let index = 1; index < samples.length; index++)
      inputStepMax = Math.max(inputStepMax, Math.abs(samples[index] - samples[index - 1]));
    // フレーム内部だけでなく、欠落の無い入力境界も比較元へ含める。
    if (previousInput !== null && Math.abs(data.timestamp - previousInput.endTimestamp) <= 1)
      inputStepMax = Math.max(inputStepMax, Math.abs(samples[0] - previousInput.tail));
    previousInput = {
      endTimestamp: data.timestamp + (data.numberOfFrames / data.sampleRate) * 1000000,
      tail: samples.at(-1),
    };
    const receivedMs = performance.now();
    const result = pushAudio(data, ...args);
    const timing = subscriber.playout.getStats().audio.timing;
    audio.push({
      timestamp: data.timestamp,
      receivedMs,
      status: result.status,
      startMs: timing.lastStartMs,
    });
    return result;
  };
  const videoOutput = subscriber.playout.video.session.output;
  const present = videoOutput.present.bind(videoOutput);
  videoOutput.present = (frame, plannedMs) => {
    drawing.drawImage(frame, 0, 0);
    video.push({ timestamp: frame.timestamp, presentedMs: performance.now(), plannedMs });
    return present(frame, plannedMs);
  };
  const receive = subscriber.receiveAudioObject.bind(subscriber);
  /** @type {bigint | null} 最初の実 Datagram の Group */
  let firstGroup = null;
  let randomState = 0x74219;
  let packets = 0;
  let droppedPackets = 0;
  const droppedGroups = new Set();
  const deliveredGroups = new Set();
  // 実回線で届いた Object の一部を、重複排除と復号の前で落とす。
  subscriber.receiveAudioObject = (
    /** @type {import("../src/dataStream").MoqtObject} */ object,
    delivery,
  ) => {
    if (delivery === "datagram") {
      packets++;
      firstGroup ??= object.groupId;
      const index = Number(object.groupId - firstGroup);
      randomState = (randomState * 1664525 + 1013904223) >>> 0;
      const lost =
        (pattern === "random5" && randomState / 4294967296 < 0.05) ||
        (pattern === "burst3" && index % 50 >= 20 && index % 50 < 23);
      if (lost) {
        droppedPackets++;
        droppedGroups.add(object.groupId.toString());
        return;
      }
      deliveredGroups.add(object.groupId.toString());
    }
    receive(object, delivery);
  };
  const element = document.createElement("video");
  element.muted = true;
  element.autoplay = true;
  document.body.append(element);
  const videoCallbacks = [];
  let videoCallback = null;
  const frameCallback = (now, metadata) => {
    videoCallbacks.push({
      now,
      mediaTime: metadata.mediaTime,
      expectedDisplayTime: metadata.expectedDisplayTime,
    });
    videoCallback = element.requestVideoFrameCallback(frameCallback);
  };
  let tap = null;
  const capture = [];
  const statsSeries = [];
  let sourceStarted = false;
  try {
    await context.resume();
    source.start();
    sourceStarted = true;
    await publisher.start(stream);
    await subscriber.start();
    element.srcObject = subscriber.mediaStream;
    await element.play();
    videoCallback = element.requestVideoFrameCallback(frameCallback);
    tap = await captureOutput(subscriber, capture);
    const startedMs = performance.now();
    for (let second = 0; second < seconds; second++) {
      await sleep(1000);
      statsSeries.push({
        second: second + 1,
        subscriber: subscriber.getStats(),
        playout: subscriber.playout.getStats(),
      });
    }
    const stats = subscriber.getStats();
    const playoutStats = subscriber.playout.getStats();
    const publisherStats = publisher.getStats();
    // 停止で接続を閉じた通知を、配信中のエラーと混ぜない。
    const activeErrors = [...errors];
    if (subscriber.state === "active") await subscriber.stop();
    await sleep(50);
    const { samples, stepMax, captureMissingMs, captureMaxGapMs, captureFrames } =
      summarizeCapture(capture);
    const activeAudio = audio.filter(
      (row) => row.status === "played" && row.receivedMs >= startedMs + 1000,
    );
    const activeVideo = video.filter((row) => row.presentedMs >= startedMs + 1000);
    // 異なる周期の capture では同じ TIMESTAMP が無い。隣接する音声予約から、
    // 映像の媒体時刻に相当する音声の時刻を換算する。実スピーカーの観測とは区別する。
    const orderedAudio = activeAudio.toSorted((left, right) => left.timestamp - right.timestamp);
    const pairs = [];
    let audioIndex = 0;
    for (const row of activeVideo) {
      while (
        audioIndex + 1 < orderedAudio.length &&
        orderedAudio[audioIndex + 1].timestamp <= row.timestamp
      )
        audioIndex++;
      const matching = orderedAudio[audioIndex];
      if (!matching || Math.abs(row.timestamp - matching.timestamp) > 20000) continue;
      pairs.push({
        timestamp: row.timestamp,
        distanceMicros: row.timestamp - matching.timestamp,
        skewMs: row.presentedMs - (matching.startMs + (row.timestamp - matching.timestamp) / 1000),
      });
    }
    const enoughOutput = hasAvCoverage({
      seconds,
      capturedSamples: samples.length,
      audioCount: activeAudio.length,
      videoCount: activeVideo.length,
      pairCount: pairs.filter((row) => Number.isFinite(row.skewMs)).length,
    });
    const age = (row, at) => performance.timeOrigin + at - row.timestamp / 1000;
    return {
      caseName,
      variant,
      seconds,
      moduleUrl,
      packets,
      droppedPackets,
      lostGroups: [...droppedGroups].filter((group) => !deliveredGroups.has(group)).length,
      audioAgeMs: distribution(activeAudio.map((row) => age(row, row.startMs))),
      videoAgeMs: distribution(activeVideo.map((row) => age(row, row.presentedMs))),
      estimatedAbsoluteSkewMs: distribution(pairs.map((row) => Math.abs(row.skewMs))),
      captureMethod: "audio-worklet-native-context",
      capturedSeconds: samples.length / RATE,
      captureMissingMs,
      captureMaxGapMs,
      captureFrames,
      stepMax,
      inputStepMax,
      stats,
      playoutStats,
      publisherStats,
      statsSeries,
      audio,
      video,
      pairs,
      videoCallbacks,
      valid: activeErrors.length === 0 && enoughOutput && captureMissingMs === 0 && stepMax > 0,
      activeErrors,
      shutdownErrors: errors.slice(activeErrors.length),
      states,
      recordings: [
        { name: `${caseName}-${variant}`, sampleRate: RATE, samples: Array.from(samples) },
      ],
    };
  } finally {
    clearInterval(paintTimer);
    if (videoCallback !== null) element.cancelVideoFrameCallback(videoCallback);
    if (tap !== null) {
      tap.port.close();
      tap.disconnect();
    }
    await Promise.allSettled([subscriber.close(), publisher.close()]);
    if (sourceStarted) source.stop();
    stream.getTracks().forEach((track) => track.stop());
    element.srcObject = null;
    element.remove();
    inputCanvas.remove();
    outputCanvas.remove();
    await context.close();
  }
}
