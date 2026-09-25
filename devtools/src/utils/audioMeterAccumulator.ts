/**
 * 配信側の音声メーターの値をまとめる
 *
 * 取っている音の AudioData は、マイクでは 10 ms ごとに届く。届くたびに画面の値を
 * 変えると描き直しが多すぎるため、サンプルを溜めて間隔ごとに peak / RMS (dBFS) と直近の
 * 波形を出す。値の求め方は受信側のメーターと同じ関数 (utils/audioLevel.ts) を使い、
 * 送る側と受ける側の値をそのまま比べられるようにする。時刻は呼び出し側が渡す。
 */

import { appendWaveform, summarizeAudioLevel, waveformSampleCount } from "./audioLevel";

/** 画面へ出すメーターの値 */
export interface AudioMeterSnapshot {
  peakDbfs: number;
  rmsDbfs: number;
  /** 直近の波形 (第 1 チャンネル) */
  waveform: Float32Array;
}

export class AudioMeterAccumulator {
  private readonly intervalMs: number;
  private pending: Float32Array[] = [];
  private waveform: Float32Array | null = null;
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
   * @param samples - 第 1 チャンネルのサンプル列 (`readAudioSamples`)
   * @param sampleRate - サンプルレート (Hz)
   * @param nowMs - 現在の時刻 (`performance.now()`)
   * @returns 出す値。間隔の間は null
   */
  push(samples: Float32Array, sampleRate: number, nowMs: number): AudioMeterSnapshot | null {
    this.pending.push(samples);
    this.waveform = appendWaveform(this.waveform, samples, waveformSampleCount(sampleRate));
    if (this.lastEmitMs !== null && nowMs - this.lastEmitMs < this.intervalMs) {
      return null;
    }
    const length = this.pending.reduce((sum, chunk) => sum + chunk.length, 0);
    const joined = new Float32Array(length);
    let offset = 0;
    for (const chunk of this.pending) {
      joined.set(chunk, offset);
      offset += chunk.length;
    }
    this.pending = [];
    this.lastEmitMs = nowMs;
    return { ...summarizeAudioLevel(joined), waveform: this.waveform };
  }
}
