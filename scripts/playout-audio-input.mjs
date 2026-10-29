/** 実際の音源の準備と Opus 往復。旧実装との比較や遅延制御には依存しない。 */
import { encodeObjectDatagram, decodeObjectDatagram } from "../src/dataStream/datagram.ts";
import { OpusDecoderTimestamps } from "../src/codec/opusDecoderTimestamps.ts";
import { requireAudioFrame } from "./playout-measurement-guards.mjs";

const RATE = 48000;
const FRAME = 960;
/** 定常音と、周期推定に都合がよすぎない有声 / 無声混合の合成音声を用意する。 */
function signal(position, rate, frequency, kind = "sine") {
  const time = position / rate;
  const phase = 2 * Math.PI * frequency * time;
  if (kind === "sine") return 0.3 * Math.sin(phase);
  let sample = 0;
  for (let harmonic = 1; harmonic <= 20 && harmonic * frequency < rate / 2; harmonic++) {
    const formant = 0.2 + Math.exp(-(((harmonic * frequency - 1000) / 650) ** 2));
    sample += (formant / harmonic) * Math.sin(harmonic * phase);
  }
  if (kind === "voiced") return sample * 0.35;
  // 300 ms の音節と 100 ms の休止。定常トーンより相関が崩れやすい音源である。
  const syllable = time % 0.4;
  const envelope = syllable < 0.3 ? Math.sin((Math.PI * syllable) / 0.3) ** 2 : 0;
  const breath = Math.sin(2 * Math.PI * 3251 * time) * Math.sin(2 * Math.PI * 4789 * time);
  return envelope * (sample * 0.35 + breath * 0.025);
}

export function frameAt(index, rate, frequency, kind = "sine") {
  const count = Math.round(rate / 50);
  return Float32Array.from({ length: count }, (_, offset) =>
    signal(index * count + offset, rate, frequency, kind),
  );
}

export async function opusFrames(
  frequency = 170,
  count = 150,
  inputSamples = null,
  transport = null,
) {
  if (
    !Number.isInteger(count) ||
    count <= 0 ||
    (inputSamples !== null && inputSamples.length !== count * FRAME)
  )
    throw new Error("Invalid Opus input length");
  const encoded = [];
  const decoded = [];
  let failure = null;
  const encoder = new AudioEncoder({
    output: (chunk) => encoded.push(chunk),
    error: (error) => {
      failure = error;
    },
  });
  encoder.configure({ codec: "opus", sampleRate: RATE, numberOfChannels: 1, bitrate: 64000 });
  for (let index = 0; index < count; index++) {
    const data = new AudioData({
      format: "f32-planar",
      sampleRate: RATE,
      numberOfChannels: 1,
      numberOfFrames: FRAME,
      timestamp: index * 20000,
      data:
        inputSamples === null
          ? frameAt(index, RATE, frequency, "speech")
          : inputSamples.slice(index * FRAME, (index + 1) * FRAME),
    });
    encoder.encode(data);
    data.close();
  }
  await encoder.flush();
  encoder.close();
  if (encoded.length < count) throw new Error("Incomplete Opus encoding");
  const timestamps = new OpusDecoderTimestamps(transport !== null);
  const pendingIndices = [];
  const submittedIndices = [];
  const rawOutput = [];
  const decoder = new AudioDecoder({
    output: (data) => {
      rawOutput.push(data.timestamp);
      data = timestamps.restore(data);
      const samples = new Float32Array(data.numberOfFrames);
      data.copyTo(samples, { planeIndex: 0, format: "f32-planar" });
      decoded.push({
        timestamp: data.timestamp,
        samples,
        packetIndex: pendingIndices.shift(),
      });
      data.close();
    },
    error: (error) => {
      failure = error;
    },
  });
  decoder.configure({ codec: "opus", sampleRate: RATE, numberOfChannels: 1 });
  const transportStats = {
    objects: encoded.length,
    packets: 0,
    lostPackets: 0,
    lostObjects: 0,
    wireBytes: 0,
    received: [],
  };
  let randomState = 0x74219;
  for (const [index, chunk] of encoded.entries()) {
    if (transport === null) {
      pendingIndices.push(index);
      submittedIndices.push(index);
      decoder.decode(chunk);
      continue;
    }
    const payload = new Uint8Array(chunk.byteLength);
    chunk.copyTo(payload);
    const wire = encodeObjectDatagram({
      type: 0x0c,
      trackAlias: 1n,
      groupId: BigInt(index),
      objectId: 0n,
      payload,
    });
    let received = false;
    for (let copy = 0; copy < transport.copies; copy++) {
      transportStats.packets++;
      transportStats.wireBytes += wire.length;
      randomState = (randomState * 1664525 + 1013904223) >>> 0;
      const randomLoss =
        transport.pattern.startsWith("random") &&
        randomState / 4294967296 < Number(transport.pattern.slice(6)) / 100;
      const burstLength = transport.pattern.startsWith("burst")
        ? Number(transport.pattern.slice(5))
        : 0;
      // 同時送信の複製は同じ連続損失に巻き込まれる。先頭と flush の末尾は比較用に残す。
      const burstLoss = burstLength > 0 && index % 50 >= 20 && index % 50 < 20 + burstLength;
      if (index > 0 && index < encoded.length - 1 && (randomLoss || burstLoss)) {
        transportStats.lostPackets++;
        continue;
      }
      if (received) continue;
      const [object, consumed] = decodeObjectDatagram(wire);
      if (consumed !== wire.length || object.groupId !== BigInt(index))
        throw new Error("Datagram round trip failed");
      pendingIndices.push(index);
      submittedIndices.push(index);
      timestamps.submit(chunk.timestamp);
      decoder.decode(
        new EncodedAudioChunk({
          type: chunk.type,
          timestamp: chunk.timestamp,
          duration: chunk.duration,
          data: object.payload,
        }),
      );
      transportStats.received.push({ index, timestamp: chunk.timestamp });
      received = true;
    }
    if (!received) transportStats.lostObjects++;
  }
  await decoder.flush();
  decoder.close();
  if (failure !== null) throw new Error("Opus codec failed", { cause: failure });
  if (decoded.length !== submittedIndices.length || pendingIndices.length > 0)
    throw new Error("Incomplete Opus decoding");
  decoded.forEach((frame, index) => requireAudioFrame(frame, submittedIndices[index], FRAME));
  decoded.transportStats = transportStats;
  if (transport !== null)
    transportStats.output = decoded.map((frame) => ({
      timestamp: frame.timestamp,
      packetIndex: frame.packetIndex,
    }));
  if (transport !== null) transportStats.rawOutput = rawOutput;
  return decoded;
}

/** 公開発話 / 日本語読み上げ音源を 6 秒の連続入力にする。短い音源の間には休止を置く。 */
export async function loadSpeech(name, durationSeconds = 6) {
  const [sourceName, part] = String(name).split(":");
  const offset = Number(part ?? 0) * RATE * 6;
  const url = new URL(
    `../investigation-logs/playout-quality-2026-10-28/speech-input/${sourceName}.wav`,
    import.meta.url,
  );
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Japanese speech source is unavailable: ${String(name)}`);
  const context = new OfflineAudioContext(1, RATE, RATE);
  const buffer = await context.decodeAudioData(await response.arrayBuffer());
  const original = buffer.getChannelData(0);
  if (
    original.length === 0 ||
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0 ||
    !Number.isInteger(offset) ||
    offset < 0 ||
    offset >= original.length
  )
    throw new Error("Invalid Japanese speech input range");
  const samples = new Float32Array(RATE * durationSeconds);
  for (let index = 0; index < samples.length; index++) {
    samples[index] =
      original[
        original.length < samples.length
          ? index % (original.length + Math.round(RATE * 0.2))
          : index + offset
      ] ?? 0;
  }
  return samples;
}
