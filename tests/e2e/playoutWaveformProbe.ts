/** ソース版と配布版の同じ実出力を、分割しない Web Audio の出力と照合する。 */
import type { AudioPlayoutDecision } from "../../src/playout/audioPlayout";

interface WaveformOutput {
  context: BaseAudioContext;
  destination: AudioNode;
}

/** 出力経路は実セッションのものを呼び、AudioData と Web Audio の代用品は使わない。 */
export interface AudioWaveformSession {
  prepareOutput(output: WaveformOutput): Promise<void>;
  playSound(
    output: WaveformOutput,
    decision: Extract<AudioPlayoutDecision, { kind: "play" }>,
    data: AudioData,
    channels: Float32Array[],
  ): { playedSeconds: number; startAtSeconds: number };
}

export interface AudioWaveformResult {
  maximumError: number;
  signalToErrorDb: number;
}

export async function compareContinuousWaveform(
  session: AudioWaveformSession,
  contextRate: number,
  decodedRate: number,
): Promise<AudioWaveformResult> {
  const context = new OfflineAudioContext(2, contextRate * 3, contextRate);
  const merger = context.createChannelMerger(2);
  merger.connect(context.destination);
  const destination = context.createGain();
  destination.connect(merger, 0, 1);
  const output = { context, destination };
  await session.prepareOutput(output);
  // 子音にも含まれる高い周波数を加え、DC と単一の低音だけで品質を判定しない。
  const signal = Float32Array.from(
    { length: decodedRate * 2 },
    (_, index) =>
      0.12 * Math.sin((index * 2 * Math.PI * 173) / decodedRate) +
      0.08 * Math.sin((index * 2 * Math.PI * 3109) / decodedRate),
  );
  const start = 0.12 + 0.37 / contextRate;
  const reference = context.createBufferSource();
  reference.buffer = context.createBuffer(1, signal.length, decodedRate);
  reference.buffer.copyToChannel(signal, 0);
  reference.connect(merger, 0, 0);
  reference.start(start);
  let offset = 0;
  let startAt = start;
  let sequence = 0;
  while (offset < signal.length) {
    // 圧縮後と同様に、フレームの終端が出力のサンプル格子から外れる長さを使う。
    const frames = Math.min(
      Math.round(decodedRate / 50) - (sequence % 7) * 13,
      signal.length - offset,
    );
    const channels = [signal.slice(offset, offset + frames)];
    const data = new AudioData({
      format: "f32-planar",
      sampleRate: decodedRate,
      numberOfChannels: 1,
      numberOfFrames: frames,
      timestamp: Math.round((offset / decodedRate) * 1000000),
      data: channels[0] ?? new Float32Array(),
    });
    try {
      const played = session.playSound(
        output,
        {
          kind: "play",
          startAt,
          basis: "timestamp",
          compressSeconds: 0,
          gapStartSeconds: 0,
          gapSeconds: 0,
          totalGapSeconds: 0,
          unrecoverableGapSeconds: 0,
        },
        data,
        channels,
      );
      startAt = played.startAtSeconds + played.playedSeconds;
    } finally {
      data.close();
    }
    offset += frames;
    sequence++;
  }
  await session.prepareOutput(output);
  const rendered = await context.startRendering();
  const expected = rendered.getChannelData(0);
  const actual = rendered.getChannelData(1);
  let energy = 0;
  let errorEnergy = 0;
  let maximumError = 0;
  for (
    let index = Math.ceil((start + 0.01) * contextRate);
    index < Math.floor((start + 1.99) * contextRate);
    index++
  ) {
    const value = expected[index] ?? 0;
    const error = (actual[index] ?? 0) - value;
    energy += value * value;
    errorEnergy += error * error;
    maximumError = Math.max(maximumError, Math.abs(error));
  }
  return { maximumError, signalToErrorDb: 10 * Math.log10(energy / Math.max(1e-30, errorEnergy)) };
}
