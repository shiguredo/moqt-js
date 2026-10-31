import { expandAudio } from "./audioExpansion";
import { AUDIO_PLAYOUT_BOUNDARY_STEP_THRESHOLD } from "./audioPlayoutTimingStats";

export interface AudioRenderRange {
  readonly start: number;
  readonly end: number;
  readonly channels?: number;
}
export interface AudioRenderOptions {
  readonly ranges?: readonly AudioRenderRange[];
  readonly stopFrame?: number;
}
export type AudioRenderControl =
  | ({ readonly type: "range" } & AudioRenderRange)
  | { readonly type: "stop"; readonly frame: number }
  | { readonly type: "reset" };

/**
 * 出力時計で実音と欠落を選ぶ。正常区間は入力をそのまま通し、実際の欠落時だけ補間する。
 * 履歴は Web Audio がレート変換した後の PCM であり、別のリサンプラーを重ねない。
 * NetEq の GetAudio / Expand / Merge にある出力側の判断を参考にするが、上流の移植ではない。
 * 根拠は WebRTC 031cc215615895d7ae039d4098c2716d7acf2dc3 の neteq_impl.cc と merge.cc。
 */
export class AudioRenderConcealer {
  private nextFrame = 0;
  private ranges: AudioRenderRange[];
  private stopFrame: number;
  private history: Float32Array[] = [];
  private historyHead = 0;
  private historyFrames = 0;
  private expansion: Float32Array[] = [];
  private expansionIndex = 0;
  private started = false;
  private wasReal = false;
  private formatChannels = 0;
  private headRemaining = 0;
  private headFrames = 1;
  private mergeRemaining = 0;
  readonly fadeFrames: number;
  readonly historyLimit: number;
  concealedFrames = 0;
  uncoveredFrames = 0;
  uncoveredMaxFrames = 0;
  boundaryStepMax = 0;
  boundaryStepCount = 0;
  concealments = 0;
  gaps = 0;
  private uncovered = false;
  private uncoveredRunFrames = 0;
  private lastOutput = new Float32Array(0);

  constructor(
    readonly sampleRate: number,
    options: AudioRenderOptions = {},
  ) {
    this.ranges = [...(options.ranges ?? [])];
    this.stopFrame = options.stopFrame ?? Infinity;
    this.fadeFrames = Math.max(1, Math.round(sampleRate * 0.002));
    this.historyLimit = Math.round(sampleRate * 0.03);
  }

  control(message: AudioRenderControl): void {
    if (message.type === "range") {
      this.ranges.push(message);
      // drain 中に届いた実音も鳴らし切るが、その後に新しい予測音は足さない。
      if (Number.isFinite(this.stopFrame)) this.stopFrame = Math.max(this.stopFrame, message.end);
    } else if (message.type === "stop") this.stopFrame = Math.min(this.stopFrame, message.frame);
    else {
      this.ranges = [];
      this.stopFrame = Infinity;
      this.historyFrames = 0;
      this.historyHead = 0;
      this.started = false;
      this.wasReal = false;
      this.formatChannels = 0;
      this.expansion = [];
      this.expansionIndex = 0;
      this.headRemaining = 0;
      this.mergeRemaining = 0;
      this.uncoveredRunFrames = 0;
    }
  }

  /** 保持済みの末尾を時系列へ戻す。欠落を検出したときだけ割り当てる。 */
  private predict(): void {
    const channels = this.history.map((ring) => {
      const samples = new Float32Array(this.historyFrames);
      for (let index = 0; index < samples.length; index++)
        samples[index] =
          ring[(this.historyHead - samples.length + index + ring.length) % ring.length] ?? 0;
      return samples;
    });
    const currentFrames = Math.min(this.historyFrames, Math.round(this.sampleRate * 0.02));
    const current = channels.map((channel) => channel.subarray(channel.length - currentFrames));
    this.expansion = expandAudio(current, this.sampleRate, channels);
    if (this.expansion.length === 0)
      this.expansion = channels.map((channel) =>
        new Float32Array(this.fadeFrames).fill(channel.at(-1) ?? 0),
      );
    this.expansionIndex = 0;
  }

  /** 実音の開始と形式変更だけを処理し、サンプルの混合と履歴更新から分ける。 */
  private beginReal(range: AudioRenderRange, outputChannels: number): void {
    const formatChannels = range.channels ?? outputChannels;
    const formatChanged = this.started && formatChannels !== this.formatChannels;
    if (!this.started) {
      this.headFrames = Math.min(
        this.fadeFrames,
        Math.max(1, Math.floor((range.end - range.start) / 2)),
      );
      this.headRemaining = this.headFrames;
    } else if (!this.wasReal || formatChanged) {
      // チャンネル数の変更でも、直前の実音と新しい実音を出力側で接続する。
      if (this.wasReal && formatChanged) this.predict();
      this.mergeRemaining = this.fadeFrames;
    }
    this.formatChannels = formatChannels;
    this.started = true;
    this.uncovered = false;
    this.uncoveredRunFrames = 0;
  }

  /** 128 サンプルに固定せず、実レンダリング量子の長さで処理する。 */
  process(
    input: readonly Float32Array[],
    output: readonly Float32Array[],
    reportedFrame: number,
  ): void {
    if (output.length !== this.history.length) {
      this.history = output.map(() => new Float32Array(this.historyLimit));
      this.historyFrames = 0;
      this.historyHead = 0;
      this.expansion = [];
      this.lastOutput = new Float32Array(output.length);
    }
    const frames = output[0]?.length ?? 0;
    // Chrome の連続 source の描画で、入力は次へ進むのに currentFrame が一量子前の値を
    // 再び返すケースを実測した。処理済みのサンプル位置へ戻らず、実描画量で進める。
    const firstFrame = Math.max(reportedFrame, this.nextFrame);
    this.nextFrame = firstFrame + frames;
    for (let index = 0; index < frames; index++) {
      const frame = firstFrame + index;
      while (this.ranges[0] !== undefined && frame >= this.ranges[0].end) this.ranges.shift();
      const range = this.ranges[0];
      const real = range !== undefined && frame >= range.start && frame < this.stopFrame;
      const boundary = real !== this.wasReal || (real && frame === range.start);
      if (real) {
        this.beginReal(range, output.length);
        const headGain = this.headRemaining > 0 ? 1 - this.headRemaining / this.headFrames : 1;
        const realGain = this.mergeRemaining > 0 ? 1 - this.mergeRemaining / this.fadeFrames : 1;
        const stopGain = Math.max(0, Math.min(1, (this.stopFrame - frame) / this.fadeFrames));
        for (let channel = 0; channel < output.length; channel++) {
          const value = input[channel]?.[index] ?? 0;
          const prediction = this.expansion[channel]?.[this.expansionIndex] ?? 0;
          const samples = output[channel];
          if (samples !== undefined)
            samples[index] = (value * realGain + prediction * (1 - realGain)) * headGain * stopGain;
          const history = this.history[channel];
          if (history !== undefined) history[this.historyHead] = value;
        }
        this.historyHead = (this.historyHead + 1) % this.historyLimit;
        this.historyFrames = Math.min(this.historyLimit, this.historyFrames + 1);
        if (this.headRemaining > 0) this.headRemaining--;
        if (this.mergeRemaining > 0) {
          this.mergeRemaining--;
          this.expansionIndex++;
        }
      } else if (this.started && frame < this.stopFrame) {
        if (this.wasReal) {
          this.predict();
          this.concealments++;
        }
        const length = this.expansion[0]?.length ?? 0;
        const covered = this.expansionIndex < length;
        const tailGain = Math.max(0, Math.min(1, (length - this.expansionIndex) / this.fadeFrames));
        for (let channel = 0; channel < output.length; channel++) {
          const samples = output[channel];
          if (samples !== undefined)
            samples[index] = (this.expansion[channel]?.[this.expansionIndex] ?? 0) * tailGain;
        }
        this.expansionIndex++;
        if (covered) this.concealedFrames++;
        else {
          this.uncoveredFrames++;
          this.uncoveredRunFrames++;
          this.uncoveredMaxFrames = Math.max(this.uncoveredMaxFrames, this.uncoveredRunFrames);
          if (!this.uncovered) {
            this.uncovered = true;
            this.gaps++;
          }
        }
      } else for (const channel of output) channel[index] = 0;
      this.observeBoundary(output, index, boundary);
      this.wasReal = real;
    }
  }
  /** 描画した境界を測り、予約時点の予測値と混同しない。 */
  private observeBoundary(output: readonly Float32Array[], index: number, boundary: boolean): void {
    let step = 0;
    for (let channel = 0; channel < output.length; channel++) {
      const value = output[channel]?.[index] ?? 0;
      if (boundary) step = Math.max(step, Math.abs(value - (this.lastOutput[channel] ?? 0)));
      this.lastOutput[channel] = value;
    }
    if (boundary) {
      this.boundaryStepMax = Math.max(this.boundaryStepMax, step);
      if (step > AUDIO_PLAYOUT_BOUNDARY_STEP_THRESHOLD) this.boundaryStepCount++;
    }
  }
}
