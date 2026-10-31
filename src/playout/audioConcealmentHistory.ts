import type { AudioSamples } from "./audioTimeStretch";

/**
 * 欠落補間の解析に保持する過去の長さ。
 * 最大周期 15 ms と末尾の相関窓 9.75 ms に、間引きフィルタの余裕を足す。
 * 20 ms の 1 フレームだけでは 80 Hz などの低い声を解析できない。
 * 受信済みの過去の PCM だけを保持するため、先読みと再生遅延は追加しない。
 */
export const AUDIO_CONCEALMENT_HISTORY_SECONDS = 0.03;

/** 媒体時刻と形式が連続している PCM の末尾を、欠落補間の材料として保持する。 */
export class AudioConcealmentHistory {
  private channelsValue: AudioSamples[] = [];
  private sampleRate = 0;
  private endTimestampMicros: number | null = null;

  get channels(): readonly AudioSamples[] {
    return this.channelsValue;
  }

  /** 入力は変更せず、最新の 30 ms までをコピーする。欠落の前後は連結しない。 */
  append(channels: readonly AudioSamples[], sampleRate: number, timestampMicros: number): void {
    const frames = channels[0]?.length ?? 0;
    const continuous =
      this.endTimestampMicros !== null &&
      Math.abs(timestampMicros - this.endTimestampMicros) <= 1 &&
      sampleRate === this.sampleRate &&
      channels.length === this.channelsValue.length;
    const limit = Math.round(sampleRate * AUDIO_CONCEALMENT_HISTORY_SECONDS);
    this.channelsValue = channels.map((channel, index) => {
      const previous = continuous ? this.channelsValue[index] : undefined;
      const retained = Math.min(previous?.length ?? 0, Math.max(0, limit - channel.length));
      const current = channel.subarray(Math.max(0, channel.length - limit));
      const history = new Float32Array(retained + current.length);
      if (previous !== undefined) history.set(previous.subarray(previous.length - retained));
      history.set(current, retained);
      return history;
    });
    this.sampleRate = sampleRate;
    this.endTimestampMicros = timestampMicros + (frames / sampleRate) * 1000000;
  }

  /** 出力の再開時に、旧 AudioContext の材料を捨てる。 */
  clear(): void {
    this.channelsValue = [];
    this.sampleRate = 0;
    this.endTimestampMicros = null;
  }
}
