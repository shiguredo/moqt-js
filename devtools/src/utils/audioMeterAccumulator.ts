/**
 * 配信側の音声メーターの値をまとめる
 *
 * 取っている音の AudioData は、マイクでは 10 ms ごとに届く。届くたびに画面の値を
 * 変えると描き直しが多すぎるため、サンプルを溜めて間隔ごとに peak / RMS (dBFS) と直近の
 * 波形を出す。値の求め方は受信側のメーターと同じ関数 (utils/audioLevel.ts) を使い、
 * 送る側と受ける側の値をそのまま比べられるようにする。時刻は呼び出し側が渡す。
 *
 * 左右のチャンネルは別々に求める。第 2 チャンネル (右) のサンプルが無い (モノラル) ときは
 * right を null にする。
 */

import { appendWaveform, summarizeAudioLevel, waveformSampleCount } from "./audioLevel";

/** 1 チャンネル分のメーターの値 */
export interface AudioMeterChannelSnapshot {
  peakDbfs: number;
  rmsDbfs: number;
  /** 直近の波形 */
  waveform: Float32Array;
}

/** 画面へ出すメーターの値 */
export interface AudioMeterSnapshot {
  left: AudioMeterChannelSnapshot;
  /** 第 2 チャンネル (右)。モノラルでは null */
  right: AudioMeterChannelSnapshot | null;
}

export class AudioMeterAccumulator {
  private readonly intervalMs: number;
  private pendingLeft: Float32Array[] = [];
  private pendingRight: Float32Array[] = [];
  private waveformLeft: Float32Array | null = null;
  private waveformRight: Float32Array | null = null;
  private lastEmitMs: number | null = null;

  /**
   * @param intervalMs - 値を出す間隔 (ミリ秒)
   */
  constructor(intervalMs: number) {
    this.intervalMs = intervalMs;
  }

  /**
   * AudioData 1 つ分のサンプルを溜め、間隔を過ぎていれば値を出す
   *
   * @param samplesLeft - 第 1 チャンネル (左) のサンプル列 (`readAudioSamples`)
   * @param samplesRight - 第 2 チャンネル (右) のサンプル列。モノラルでは null
   * @param sampleRate - サンプルレート (Hz)
   * @param nowMs - 現在の時刻 (`performance.now()`)
   * @returns 出す値。間隔の間は null
   */
  push(
    samplesLeft: Float32Array,
    samplesRight: Float32Array | null,
    sampleRate: number,
    nowMs: number,
  ): AudioMeterSnapshot | null {
    const maxSamples = waveformSampleCount(sampleRate);
    this.pendingLeft.push(samplesLeft);
    this.waveformLeft = appendWaveform(this.waveformLeft, samplesLeft, maxSamples);
    if (samplesRight !== null) {
      this.pendingRight.push(samplesRight);
      this.waveformRight = appendWaveform(this.waveformRight, samplesRight, maxSamples);
    }
    if (this.lastEmitMs !== null && nowMs - this.lastEmitMs < this.intervalMs) {
      return null;
    }
    this.lastEmitMs = nowMs;
    const left = summarizeChannel(this.pendingLeft, this.waveformLeft);
    this.pendingLeft = [];
    const right = summarizeChannel(this.pendingRight, this.waveformRight);
    this.pendingRight = [];
    if (left === null) {
      // 左のサンプルは push のたびに 1 つ以上来るため到達しない (型を絞るためのガード)
      return null;
    }
    return { left, right };
  }
}

/**
 * 溜めたサンプルを 1 本に繋いで peak / RMS と直近の波形を返す
 *
 * サンプルが 1 つも無いチャンネル (モノラルの右など) は null にする
 */
function summarizeChannel(
  pending: Float32Array[],
  waveform: Float32Array | null,
): AudioMeterChannelSnapshot | null {
  if (pending.length === 0 || waveform === null) {
    return null;
  }
  const length = pending.reduce((sum, chunk) => sum + chunk.length, 0);
  const joined = new Float32Array(length);
  let offset = 0;
  for (const chunk of pending) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  return { ...summarizeAudioLevel(joined), waveform };
}
