/** 同一 Opus パケットを実 WebRTC と SDK で再生し、同じ出力時計で収録する。 */
import { loadSpeech } from "./playout-audio-input.mjs";
import { AudioDecoderWrapper } from "../src/codec/AudioDecoder.ts";
import { watchProcessorErrors } from "./playout-measurement-guards.mjs";
import { compareCompression } from "./playout-compression-quality.mjs";
import {
  encodedOpusReplayPackets,
  matchReceivedOpusPackets,
} from "./playout-encoded-opus-trace.mjs";

const sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
async function waitFor(condition, label) {
  const end = performance.now() + 8000;
  while (!condition()) {
    if (performance.now() > end) throw new Error(`Timed out: ${label}`);
    await sleep(10);
  }
}

/** 実 PeerConnection のコーデックを Opus に固定し、ICE と SDP を交換する。 */
async function connectPeers(peer1, peer2, inputTrack, stream, encoderWorker, pattern, recordError) {
  const pending1 = [],
    pending2 = [];
  peer1.onicecandidate = (e) => {
    if (e.candidate) {
      if (peer2.remoteDescription) void peer2.addIceCandidate(e.candidate).catch(recordError);
      else pending2.push(e.candidate);
    }
  };
  peer2.onicecandidate = (e) => {
    if (e.candidate) {
      if (peer1.remoteDescription) void peer1.addIceCandidate(e.candidate).catch(recordError);
      else pending1.push(e.candidate);
    }
  };
  const transceiver = peer1.addTransceiver(inputTrack, {
    direction: "sendonly",
    streams: [stream],
  });
  const opus = RTCRtpSender.getCapabilities("audio").codecs.filter(
    (c) => c.mimeType.toLowerCase() === "audio/opus",
  );
  transceiver.setCodecPreferences(opus);
  transceiver.sender.transform = new RTCRtpScriptTransform(encoderWorker, { pattern });
  await peer1.setLocalDescription(await peer1.createOffer());
  await peer2.setRemoteDescription(peer1.localDescription);
  for (const candidate of pending2) await peer2.addIceCandidate(candidate);
  await peer2.setLocalDescription(await peer2.createAnswer());
  await peer1.setRemoteDescription(peer2.localDescription);
  for (const candidate of pending1) await peer1.addIceCandidate(candidate);

  return transceiver;
}

/** 収録順の欠落と描画時計の異常を分離し、原音から PCM の連続性を確かめる。 */
async function collectCapture(blocks, branches, rate, inputBuffer, startSeconds) {
  const count = blocks.reduce((n, b) => n + b.channels[0].length, 0);
  const channels = Array.from({ length: branches }, () => new Float32Array(count));
  let position = 0;
  let missing = 0;
  const captureGaps = [];
  for (const [i, b] of blocks.entries()) {
    if (
      i > 0 &&
      (b.frame !== blocks[i - 1].frame + 128 || b.renderFrame !== blocks[i - 1].renderFrame + 128)
    ) {
      if (b.frame !== blocks[i - 1].frame + 128) missing++;
      captureGaps.push({
        index: i,
        previous: blocks[i - 1].renderFrame,
        current: b.renderFrame,
        previousSequence: blocks[i - 1].frame,
        sequence: b.frame,
      });
    }
    for (let channel = 0; channel < channels.length; channel++)
      channels[channel].set(b.channels[channel], position);
    position += 128;
  }
  const peaks = channels.map((channel) =>
    channel.reduce((peak, sample) => Math.max(peak, Math.abs(sample)), 0),
  );

  // currentFrame の重複だけでは PCM が欠けたか分からない。収録経路へ入る原音を
  // 独立した OfflineAudioContext で再生し、全区間のサンプルを照合する。
  const referenceContext = new OfflineAudioContext(1, count, rate);
  const source = referenceContext.createBufferSource();
  source.buffer = inputBuffer;
  source.connect(referenceContext.destination);
  source.start(startSeconds - (blocks[0]?.renderFrame ?? 0) / rate);
  const rendered = await referenceContext.startRendering();
  const reference = rendered.getChannelData(0);
  let inputMaximumError = 0;
  for (let index = 0; index < count; index++)
    inputMaximumError = Math.max(
      inputMaximumError,
      Math.abs(channels[0][index] - reference[index]),
    );
  return { channels, peaks, missing, captureGaps, inputMaximumError };
}

/** 同じ Worklet の各入力へ接続し、別時計の収録を比較しない。 */
async function createCapture(context, branches, blocks, urls) {
  const captureUrl = URL.createObjectURL(
    new Blob(
      [
        `class Capture extends AudioWorkletProcessor {
      process(inputs,outputs) {
        this.frames ??= 0;
        this.port.postMessage({frame:this.frames,renderFrame:currentFrame,channels:inputs.map(input=>input[0]?.slice()??new Float32Array(128))});
        this.frames+=128;return true;
      }
    } registerProcessor('same-opus-capture',Capture);`,
      ],
      { type: "text/javascript" },
    ),
  );
  urls.push(captureUrl);
  await context.audioWorklet.addModule(captureUrl);
  const tap = new AudioWorkletNode(context, "same-opus-capture", {
    numberOfInputs: branches,
    numberOfOutputs: 1,
    outputChannelCount: [1],
  });
  const captureErrors = watchProcessorErrors(tap);
  tap.port.onmessage = (e) => blocks.push(e.data);
  tap.connect(context.destination);
  return { tap, captureErrors };
}

/** 実際の予約を変更せず、途絶時のフェードを予約し直せたか記録する。 */
function watchEnvelopes(playout, context, envelopes) {
  const session = playout.audio.session;
  if (typeof session.connectWithEnvelope === "function") {
    const connect = session.connectWithEnvelope.bind(session);
    session.connectWithEnvelope = (output, source, start, duration, rate) => {
      const previous = session.lastScheduledEnvelope;
      envelopes.push({
        start,
        duration,
        now: context.currentTime,
        previousEnd: previous?.endSeconds,
        tailStart: previous?.tailStartSeconds,
      });
      return connect(output, source, start, duration, rate);
    };
  } else {
    const startBuffer = session.startBuffer.bind(session);
    let previousEnd;
    session.startBuffer = (...arguments_) => {
      const now = context.currentTime;
      const result = startBuffer(...arguments_);
      const duration = arguments_[3] / arguments_[4];
      envelopes.push({ start: result.startAtSeconds, duration, now, previousEnd });
      previousEnd = result.startAtSeconds + duration;
      return result;
    };
  }
}

/** 時計を差し替えず、実際に予約へ渡った時刻と目標を記録する。 */
function watchSchedules(playout, events) {
  const scheduler = playout.audio.session.playout;
  const schedule = scheduler.schedule.bind(scheduler);
  scheduler.schedule = (now, timestamp, duration, target) => {
    const decision = schedule(now, timestamp, duration, target);
    events.push({ now, timestamp, duration, target: { ...target }, decision: { ...decision } });
    return decision;
  };
}

/** 音声の準備と計器の登録を、最初の入力より前に完了する。 */
async function prepareObservedPlayout(playout, schedules) {
  await playout.prepareAudio?.();
  watchSchedules(playout, schedules);
}

/** 統計の約 1 秒の更新制限を考慮し、初期化中の古い報告で区間を切らない。 */
async function freshPlaybackStats(context) {
  let snapshot = context.playbackStats?.toJSON?.() ?? null;
  if (snapshot === null) return null;
  const previous = snapshot.totalDuration;
  await waitFor(() => {
    snapshot = context.playbackStats.toJSON();
    return snapshot.totalDuration > previous;
  }, "AudioContext playback statistics update");
  return snapshot;
}

/** 実出力の underrun は、PCM 上の無音と別に取得する。未対応を 0 と扱わない。 */
async function startObservedInput(context, source) {
  const before = await freshPlaybackStats(context);
  const startSeconds = context.currentTime + 0.2;
  source.start(startSeconds);
  return { before, startSeconds };
}

/** 発話後まで含む新しい報告を、出力時計を停止する前に受け取る。 */
async function suspendObservedOutput(context, playback) {
  playback.after = await freshPlaybackStats(context);
  await context.suspend();
}

/** Chrome の Duration は秒なので、収録区間の差分を ms に換算する。 */
function contextPlaybackStats(before, after) {
  if (before === null || after === null) return { supported: false };
  return {
    supported: true,
    before,
    after,
    underrunEvents: after.underrunEvents - before.underrunEvents,
    underrunMs: (after.underrunDuration - before.underrunDuration) * 1000,
    totalMs: (after.totalDuration - before.totalDuration) * 1000,
  };
}

/** 実クラスに同じ時計と PCM を渡し、呼び出し時刻の差とアルゴリズムの差を分離する。 */
async function replaySharedClock(events, frames, moduleUrl, comparisonModuleUrl) {
  if (comparisonModuleUrl === undefined) return null;
  const modules = await Promise.all(
    [moduleUrl, comparisonModuleUrl].map(async (url) => {
      const [schedulerModule, stretchModule] = await Promise.all([
        import(new URL("./audioPlayout.ts", url).href),
        import(new URL("./audioTimeStretch.ts", url).href),
      ]);
      return {
        scheduler: new schedulerModule.AudioPlayoutScheduler(),
        compress: stretchModule.compressSamples,
      };
    }),
  );
  let maximumStartDifferenceSeconds = 0;
  let maximumLengthDifferenceSamples = 0;
  for (let index = 0; index < events.length; index++) {
    const event = events[index],
      frame = frames[index];
    if (event.timestamp !== frame.timestamp) throw new Error("Clock replay timestamp mismatch");
    const results = modules.map(({ scheduler, compress }) => {
      const decision = scheduler.schedule(event.now, event.timestamp, event.duration, event.target);
      if (decision.kind !== "play") throw new Error("Unexpected clock replay drop");
      const samples = Float32Array.from(frame.samples);
      const result =
        decision.compressSeconds > 0
          ? compress(
              [samples],
              frame.sampleRate,
              Math.round(decision.compressSeconds * frame.sampleRate),
            )
          : { lengthChangeSamples: 0 };
      scheduler.confirmStretch(-result.lengthChangeSamples / frame.sampleRate);
      scheduler.confirmPlayoutEnd(
        decision.startAt + (samples.length + result.lengthChangeSamples) / frame.sampleRate,
      );
      return { start: decision.startAt, change: result.lengthChangeSamples };
    });
    maximumStartDifferenceSeconds = Math.max(
      maximumStartDifferenceSeconds,
      Math.abs(results[0].start - results[1].start),
    );
    maximumLengthDifferenceSamples = Math.max(
      maximumLengthDifferenceSamples,
      Math.abs(results[0].change - results[1].change),
    );
  }
  return { frames: events.length, maximumStartDifferenceSeconds, maximumLengthDifferenceSamples };
}

/** リモート受信が実際に音を取り出したことを、PCM と受信統計の両方で検証する。 */
async function inboundAudioStats(peer) {
  const inbound = [];
  const report = await peer.getStats();
  report.forEach((r) => {
    if (r.type === "inbound-rtp" && r.kind === "audio")
      inbound.push({
        codecId: r.codecId,
        packetsReceived: r.packetsReceived,
        packetsLost: r.packetsLost,
        jitter: r.jitter,
        jitterBufferDelay: r.jitterBufferDelay,
        jitterBufferEmittedCount: r.jitterBufferEmittedCount,
        concealedSamples: r.concealedSamples,
        insertedSamplesForDeceleration: r.insertedSamplesForDeceleration,
        removedSamplesForAcceleration: r.removedSamplesForAcceleration,
        totalAudioEnergy: r.totalAudioEnergy,
      });
  });
  return inbound;
}

/** 実再生を止めてから DSP を比較し、解析の負荷を到着時刻へ混ぜない。 */
async function compressionQuality(frames, scheduled, comparisonModuleUrl, moduleUrl) {
  if (comparisonModuleUrl === undefined) return null;
  const original = await import(new URL("./audioTimeStretch.ts", comparisonModuleUrl).href);
  const candidate = await import(new URL("./audioTimeStretch.ts", moduleUrl).href);
  return compareCompression(frames, scheduled, original.compressSamples, candidate.compressSamples);
}

/** マイク処理を通さず、同じ原音を WebRTC 送信と照合用の入力へ接続する。 */
function prepareInput(context, input, tap) {
  const inputDestination = context.createMediaStreamDestination();
  inputDestination.channelCount = 1;
  const inputTrack = inputDestination.stream.getAudioTracks()[0];
  const buffer = context.createBuffer(1, input.length, 48000);
  buffer.copyToChannel(input, 0);
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.connect(inputDestination);
  source.connect(tap, 0, 0);
  return { inputDestination, inputTrack, buffer, source };
}

/** 解析中に到着列や復号 PCM が増えないよう、入力を閉じてから結果を作る。 */
function stopDecoding(peer1, peer2, encoderWorker, decoder, receiverWorker) {
  peer1.close();
  peer2.close();
  encoderWorker?.terminate();
  receiverWorker?.terminate();
  decoder?.close();
}

/** 保存した同じパケットから、別の実デコーダーで同じ PCM が得られるか確認する。 */
async function withEncodedReplay(result) {
  if (!result.valid) return result;
  const packets = encodedOpusReplayPackets(result);
  const decoded = [];
  const errors = [];
  const decoder = new AudioDecoderWrapper(true, {
    error: (error) => errors.push(error.message),
    output: ({ data }) => {
      try {
        const samples = new Float32Array(data.numberOfFrames);
        data.copyTo(samples, { planeIndex: 0, format: "f32-planar" });
        decoded.push({ timestamp: data.timestamp, samples });
      } finally {
        data.close();
      }
    },
  });
  try {
    await decoder.configure("opus", 48000, 1);
    for (const packet of packets)
      decoder.decode(new Uint8Array(packet.payload), "key", packet.timestampMicros, 20000);
    await waitFor(
      () => decoded.length >= packets.length || errors.length > 0,
      "encoded replay decoding",
    );
    let maximumError = 0;
    let mismatchedFrames = 0;
    for (const [index, frame] of decoded.entries()) {
      const expected = result.decodedFrames[index];
      if (
        expected === undefined ||
        frame.timestamp !== expected.timestamp ||
        frame.samples.length !== expected.samples.length
      ) {
        mismatchedFrames++;
        continue;
      }
      let error = 0;
      for (let sample = 0; sample < frame.samples.length; sample++)
        error = Math.max(error, Math.abs(frame.samples[sample] - expected.samples[sample]));
      maximumError = Math.max(maximumError, error);
      if (error !== 0) mismatchedFrames++;
    }
    const encodedReplay = {
      packetCount: packets.length,
      decodedCount: decoded.length,
      maximumError,
      mismatchedFrames,
      errors,
    };
    return {
      ...result,
      encodedReplay,
      valid:
        result.valid &&
        errors.length === 0 &&
        decoded.length === packets.length &&
        mismatchedFrames === 0,
    };
  } finally {
    decoder.close();
  }
}

export async function measure(caseName, { moduleUrl, comparisonModuleUrl, seconds = 6 } = {}) {
  const [, name, pattern, rateString] = caseName.split("|");
  if (!["clean", "recurring60", "jitter30"].includes(pattern))
    throw new Error(`Unknown packet pattern: ${pattern}`);
  const contextRate = Number(rateString);
  if (![44100, 48000].includes(contextRate))
    throw new Error(`Unsupported context rate: ${rateString}`);
  const { createMediaPlayout } = await import(moduleUrl);
  const comparisonModule =
    comparisonModuleUrl === undefined ? null : await import(comparisonModuleUrl);

  if (typeof RTCRtpScriptTransform !== "function")
    throw new Error("RTCRtpScriptTransform is unavailable");
  const input = await loadSpeech(name, seconds);
  const context = new AudioContext({ sampleRate: contextRate, latencyHint: "interactive" });
  await context.suspend();
  const errors = [];
  const recordError = (error) => {
    errors.push(error instanceof Error ? error.message : String(error));
  };
  const blocks = [];
  const audio = [];
  const packets = [];
  const sentPackets = [];
  const emptyReceipts = [];
  const { envelopes, schedules, comparisonSchedules, outputPlayback } = {
    envelopes: [],
    schedules: [],
    comparisonSchedules: [],
    outputPlayback: { before: null, after: null },
  };
  const decodedFrames = [];
  const peer1 = new RTCPeerConnection();
  const peer2 = new RTCPeerConnection();
  let encoderWorker;
  let receiverWorker;
  let decoder;
  let playout;
  let comparison;
  let firstTimestamp = null;
  let plainEnd = null;
  let referenceUnderruns = 0;
  let remoteSource;
  let remoteElement;
  const urls = [];
  const sources = [];
  let inputStream;
  try {
    const { tap, captureErrors } = await createCapture(
      context,
      comparisonModule === null ? 4 : 5,
      blocks,
      urls,
    );
    const { inputDestination, inputTrack, buffer, source } = prepareInput(context, input, tap);
    inputStream = inputDestination.stream;
    sources.push(source);
    const output = context.createGain();
    output.connect(tap, 0, 2);
    await context.resume();
    playout = createMediaPlayout({ audio: { context, destination: output } });
    await prepareObservedPlayout(playout, schedules);
    const comparisonAudio = [];
    if (comparisonModule !== null) {
      const destination = context.createGain();
      destination.connect(tap, 0, 4);
      comparison = comparisonModule.createMediaPlayout({ audio: { context, destination } });
      await prepareObservedPlayout(comparison, comparisonSchedules);
    }
    const push = (target, data, records) => {
      const before = target.audio.session.playout.compressed;
      const at = performance.now();
      target.trackAudioDecodeInput(data.timestamp, { timestampKind: "mediaTime" });
      const result = target.pushAudio(data);
      const handlingMs = performance.now() - at;
      if (result.status === "error") errors.push(result.error.message);
      records.push({
        timestamp: data.timestamp,
        compressedDeltaMs: (target.audio.session.playout.compressed - before) * 1000,
        status: result.status,
        atMs: at,
        handlingMs,
        timing: target.getStats().audio.timing,
      });
    };
    watchEnvelopes(playout, context, envelopes);
    decoder = new AudioDecoderWrapper(true, {
      error: (e) => errors.push(e.message),
      output: ({ data }) => {
        const samples = new Float32Array(data.numberOfFrames);
        data.copyTo(samples, { planeIndex: 0, format: "f32-planar" });
        const plain = context.createBufferSource();
        const b = context.createBuffer(1, samples.length, 48000);
        b.copyToChannel(samples, 0);
        plain.buffer = b;
        plain.connect(tap, 0, 3);
        if (plainEnd === null) plainEnd = context.currentTime + 0.2;
        if (plainEnd < context.currentTime) referenceUnderruns++;
        plain.start(plainEnd);
        plainEnd += samples.length / 48000;
        plain.stop(plainEnd);
        plain.onended = () => plain.disconnect();
        // 呼び出し順による負荷の偏りを避ける。入力 PCM と到着イベントは両者で共有する。
        try {
          decodedFrames.push({
            timestamp: data.timestamp,
            sampleRate: data.sampleRate,
            channels: data.numberOfChannels,
            samples: Array.from(samples),
          });
          if (comparison !== undefined && decodedFrames.length % 2 === 0)
            push(comparison, data, comparisonAudio);
          push(playout, data, audio);
          if (comparison !== undefined && decodedFrames.length % 2 !== 0)
            push(comparison, data, comparisonAudio);
        } finally {
          data.close();
        }
      },
    });
    await decoder.configure("opus", 48000, 1);
    const mirrorUrl = URL.createObjectURL(
      new Blob(
        [
          `self.onrtctransform=event=>{
      const transformer=event.transformer;let sequence=0;let firstTimestamp=null;let baseMs=null;const pattern=transformer.options.pattern;let startMediaMs=Infinity;self.onmessage=event=>{if(event.data.type==='start')startMediaMs=event.data.mediaMs;};
      transformer.readable.pipeThrough(new TransformStream({async transform(frame,controller){
        const data=frame.data.slice(0);const timestamp=frame.timestamp;const pts=frame.getMetadata().timestamp;
        if(firstTimestamp===null){firstTimestamp=timestamp;baseMs=performance.now();}
        const mediaMs=((timestamp-firstTimestamp)>>>0)/48;
        const speechMs=mediaMs-startMediaMs;const extra=pattern==='recurring60'&&speechMs>=1000&&speechMs%1200>=400&&speechMs%1200<480?60:pattern==='jitter30'&&speechMs>=1000?(sequence*37%31):0;
        const due=baseMs+mediaMs+extra;
        if(extra>0&&due>performance.now())await new Promise(resolve=>setTimeout(resolve,due-performance.now()));
        const releasedAtMs=performance.timeOrigin+performance.now();
        controller.enqueue(frame);self.postMessage({type:'packet',timestamp,pts,data,sequence:sequence++,releasedAtMs},[data]);
      }})).pipeTo(transformer.writable).catch(error=>self.postMessage({type:'error',message:error.message}));
    };`,
        ],
        { type: "text/javascript" },
      ),
    );
    urls.push(mirrorUrl);
    encoderWorker = new Worker(mirrorUrl);
    encoderWorker.onerror = (e) => errors.push(e.message);
    encoderWorker.onmessage = (e) => {
      if (e.data.type === "error") {
        errors.push(e.data.message);
        return;
      }
      const { timestamp, data, sequence, releasedAtMs } = e.data;
      sentPackets.push({
        timestamp,
        sequence,
        releasedAtMs,
        payload: Array.from(new Uint8Array(data)),
      });
    };
    // W3C WebRTC Encoded Transform §2 / §5 の復号前の境界で複製する。
    // 策定中の仕様であり、この位置はブラウザーの実装変更時にも再確認する。
    const receiverUrl = URL.createObjectURL(
      new Blob(
        [
          `self.onrtctransform=event=>{
      const transformer=event.transformer;let sequence=0;
      transformer.readable.pipeThrough(new TransformStream({transform(frame,controller){
        const data=frame.data.slice(0);const timestamp=frame.timestamp;const pts=frame.getMetadata().timestamp;
        const releasedAtMs=performance.timeOrigin+performance.now();
        controller.enqueue(frame);self.postMessage({type:data.byteLength===0?'empty':'packet',timestamp,pts,data,sequence:data.byteLength===0?null:sequence++,releasedAtMs},[data]);
      }})).pipeTo(transformer.writable).catch(error=>self.postMessage({type:'error',message:error.message}));
    };`,
        ],
        { type: "text/javascript" },
      ),
    );
    urls.push(receiverUrl);
    receiverWorker = new Worker(receiverUrl);
    receiverWorker.onerror = (event) => errors.push(event.message);
    receiverWorker.onmessage = (e) => {
      if (e.data.type === "error") {
        errors.push(e.data.message);
        return;
      }
      // 空の RTP ペイロードは上流 ChannelReceive::OnReceivedPayloadData も NetEq へ入れない。
      // パディングなどの通知を失敗や音声パケットに混ぜず、別の列に残す。
      if (e.data.type === "empty") {
        emptyReceipts.push({ timestamp: e.data.timestamp, releasedAtMs: e.data.releasedAtMs });
        return;
      }
      const { timestamp, pts, data, sequence, releasedAtMs } = e.data;
      if (firstTimestamp === null) firstTimestamp = timestamp;
      const timestampMicros = Math.round((((timestamp - firstTimestamp) >>> 0) / 48000) * 1000000);
      packets.push({
        timestamp,
        pts,
        sequence,
        releasedAtMs,
        bytes: data.byteLength,
        payload: Array.from(new Uint8Array(data)),
        atMs: performance.now(),
      });
      decoder.decode(new Uint8Array(data), "key", timestampMicros, 20000);
    };
    peer2.ontrack = (e) => {
      e.receiver.transform = new RTCRtpScriptTransform(receiverWorker);
      remoteElement = document.createElement("audio");
      remoteElement.srcObject = new MediaStream([e.track]);
      document.body.append(remoteElement);
      // Chrome はリモート track の Web Audio 接続だけでは NetEq を駆動しない。
      // 音声要素で駆動し、その音を消して同じ track を収録する。
      const elementSource = context.createMediaElementSource(remoteElement);
      const muted = context.createGain();
      muted.gain.value = 0;
      elementSource.connect(muted).connect(context.destination);
      remoteSource = context.createMediaStreamSource(new MediaStream([e.track]));
      remoteSource.connect(tap, 0, 1);
      void remoteElement.play().catch(recordError);
    };
    const transceiver = await connectPeers(
      peer1,
      peer2,
      inputTrack,
      inputDestination.stream,
      encoderWorker,
      pattern,
      recordError,
    );
    await waitFor(
      () => peer1.connectionState === "connected" && remoteSource !== undefined,
      "WebRTC connection",
    );
    const parameters = transceiver.sender.getParameters();
    if (parameters.encodings[0]) {
      parameters.encodings[0].maxBitrate = 64000;
      await transceiver.sender.setParameters(parameters);
    }
    await waitFor(() => packets.length >= 25, "audio packet warmup");
    const { before: baseline, startSeconds } = await startObservedInput(context, source);
    outputPlayback.before = baseline;
    // ウォームアップ中のタイマーの偏りを除き、発声開始から遅着パターンを数える。
    encoderWorker.postMessage({
      type: "start",
      mediaMs: ((packets.at(-1).timestamp - firstTimestamp) >>> 0) / 48 + 200,
    });
    const renderingEnd = startSeconds + seconds + 0.4;
    while (context.currentTime < renderingEnd) {
      // 出力時計が止まった失敗を、長い収録の終了まで待ち続けない。
      const next = Math.min(renderingEnd, context.currentTime + 1);
      await waitFor(() => context.currentTime >= next, "audio rendering");
    }
    await suspendObservedOutput(context, outputPlayback);
    await sleep(50);
    const inbound = await inboundAudioStats(peer2);
    stopDecoding(peer1, peer2, encoderWorker, decoder, receiverWorker);
    const { channels, peaks, missing, captureGaps, inputMaximumError } = await collectCapture(
      blocks,
      comparisonModule === null ? 4 : 5,
      context.sampleRate,
      buffer,
      startSeconds,
    );
    const nativeActive = inbound.some(
      (stats) =>
        stats.jitterBufferEmittedCount > 48000 * (seconds - 1) && stats.totalAudioEnergy > 0,
    );
    const branchNames = [
      "input",
      "webrtc",
      "current",
      "decoded",
      ...(comparisonModule === null ? [] : ["comparison"]),
    ];
    return await withEncodedReplay({
      name,
      pattern,
      seconds,
      envelopes,
      schedules,
      comparisonSchedules,
      commonClockReplay: await replaySharedClock(
        schedules,
        decodedFrames,
        moduleUrl,
        comparisonModuleUrl,
      ),
      decodedFrames,
      peaks,
      contextPlayback: contextPlaybackStats(outputPlayback.before, outputPlayback.after),
      rendererError: playout.audio.session.renderer?.failure?.message ?? null,
      valid:
        (playout.audio.session.renderer?.failure ?? null) === null &&
        nativeActive &&
        peaks.every((peak) => peak > 0.01) &&
        errors.length === 0 &&
        captureErrors.length === 0 &&
        missing === 0 &&
        inputMaximumError < 1e-6 &&
        packets.length > seconds * 40 &&
        referenceUnderruns === 0 &&
        audio.every((record) => record.status === "played") &&
        comparisonAudio.every((record) => record.status === "played"),
      errors,
      captureErrors,
      missing,
      captureGaps,
      inputMaximumError,
      referenceUnderruns,
      contextRate: context.sampleRate,
      startSeconds,
      firstRenderFrame: blocks[0]?.renderFrame,
      captureSamples: channels[0].length,
      baseLatency: context.baseLatency,
      outputLatency: context.outputLatency,
      inputSettings: {
        sampleRate: inputTrack.getSettings().sampleRate,
        channelCount: inputTrack.getSettings().channelCount,
      },
      inbound,
      packetCount: packets.length,
      arrivalStage: "receiver-transform",
      packetIdentity: matchReceivedOpusPackets(sentPackets, packets),
      sentPackets,
      emptyReceipts,
      packets,
      audio,
      playout: playout.getStats().audio,
      comparisonAudio,
      comparisonPlayout: comparison?.getStats().audio,
      compressionQuality: await compressionQuality(
        decodedFrames,
        audio,
        comparisonModuleUrl,
        moduleUrl,
      ),
      branchNames,
      recordings: channels.map((samples, index) => ({
        name: `${caseName}-${branchNames[index]}`,
        sampleRate: context.sampleRate,
        samples: Array.from(samples),
        saveFloat32: true,
      })),
    });
  } finally {
    remoteElement?.pause();
    if (remoteElement) {
      remoteElement.srcObject = null;
      remoteElement.remove();
    }
    for (const track of inputStream?.getTracks() ?? []) track.stop();
    stopDecoding(peer1, peer2, encoderWorker, decoder, receiverWorker);
    playout?.clearAll();
    comparison?.clearAll();
    for (const source of sources)
      try {
        source.stop();
      } catch {}
    await context.close();
    for (const url of urls) URL.revokeObjectURL(url);
  }
}
