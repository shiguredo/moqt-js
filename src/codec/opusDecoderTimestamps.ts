/**
 * raw Opus の入力パケットと出力の対応から媒体の timestamp を保つ。
 * Chromium 156 の実測では、欠落後も復号出力の時計だけが連続し、20 ms の欠落が消えた。
 * raw Opus は 1 パケットごとに出力されるため、投入順の時刻を使う。priming のある
 * description 付きの形式と、出力の対応が異なる他の codec には適用しない。
 */
export class OpusDecoderTimestamps {
  private readonly pending: (number | null)[] = [];

  constructor(private readonly enabled: boolean) {}

  submit(timestamp: number | null): void {
    if (this.enabled) this.pending.push(timestamp);
  }

  rejectLast(): void {
    if (this.enabled) this.pending.pop();
  }

  restore(data: AudioData): AudioData {
    if (!this.enabled) return data;
    const timestamp = this.pending.shift();
    // 時刻なしは null とし、媒体時刻 0 と区別して復号器の連続時計を保つ。
    if (timestamp === undefined || timestamp === null || timestamp === data.timestamp) return data;
    // 音を待たせず、その出力だけを元の時刻へ戻す。入力の AudioData はここで閉じる。
    try {
      const samples = new Float32Array(data.numberOfFrames * data.numberOfChannels);
      for (let planeIndex = 0; planeIndex < data.numberOfChannels; planeIndex++) {
        data.copyTo(
          samples.subarray(
            planeIndex * data.numberOfFrames,
            (planeIndex + 1) * data.numberOfFrames,
          ),
          { planeIndex, format: "f32-planar" },
        );
      }
      return new AudioData({
        format: "f32-planar",
        sampleRate: data.sampleRate,
        numberOfFrames: data.numberOfFrames,
        numberOfChannels: data.numberOfChannels,
        timestamp,
        data: samples,
      });
    } finally {
      data.close();
    }
  }
}
