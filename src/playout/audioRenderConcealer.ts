import { expandAudio } from "./audioExpansion";
import { AUDIO_PLAYOUT_BOUNDARY_STEP_THRESHOLD } from "./audioPlayoutTimingStats";
import { crossFadeHead, smoothSpliceHead } from "../audioSpliceFade";
import type { AudioSamples } from "./audioTimeStretch";
import { audioSourceChannelForOutput } from "./audioRenderQueue";

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
 * 履歴は出力レートへ変換した後の PCM であり、補間のために別のリサンプラーを重ねない。
 * NetEq の GetAudio / Expand / Merge にある出力側の判断を参考にするが、上流の移植ではない。
 * 根拠は WebRTC 031cc215615895d7ae039d4098c2716d7acf2dc3 の neteq_impl.cc と merge.cc。
 */
export class AudioRenderConcealer {
  private nextFrame = 0;
  private ranges: AudioRenderRange[];
  private stopFrame: number;
  private history: AudioSamples[] = [];
  private historyHead = 0;
  private historyFrames = 0;
  private expansion: AudioSamples[] = [];
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
  private stopFadeValues = new Float32Array(0);
  private stopFadeRemaining = 0;

  /** 遅れて受け取った停止を滑らかに終えるまで、プロセッサーを破棄しない。 */
  get fadingStop(): boolean {
    return this.stopFadeRemaining > 0;
  }

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
    } else if (message.type === "stop") {
      const stopFrame = Math.min(this.stopFrame, message.frame);
      if (
        stopFrame < this.stopFrame &&
        this.started &&
        stopFrame < this.nextFrame + this.fadeFrames
      ) {
        // メインスレッドから届く停止が遅い場合、過去へフェードを予約することはできない。
        // 最後に出した値から短く下げ、途中の予測音をゼロへ切り替えない。
        this.stopFadeValues = this.lastOutput.slice();
        this.stopFadeRemaining = this.fadeFrames;
      }
      this.stopFrame = stopFrame;
    } else {
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
      this.stopFadeRemaining = 0;
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
    // 実音への復帰途中は、最後に描画した値と未加工の PCM が異なる。
    // 再度の欠落で PCM の末尾へ跳ばず、実際の出力から新しい予測音へ接続する。
    // 通常の周期予測は自然な変化幅を超える段差がある場合だけ接続する。
    this.expansion =
      this.mergeRemaining > 0
        ? crossFadeHead(
            this.expansion.map((channel, index) =>
              new Float32Array(channel.length).fill(this.lastOutput[index] ?? 0),
            ),
            this.expansion,
            this.sampleRate,
          )
        : smoothSpliceHead(channels, this.expansion, this.sampleRate);
    this.mergeRemaining = 0;
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

  /** 先行予約で出力幅が増えても、実際に描画している予測と停止フェードを引き継ぐ。 */
  private resizeOutputChannels(channels: number): void {
    const previousChannels = this.history.length;
    if (previousChannels > 0 && channels > previousChannels) {
      const sources = Array.from({ length: channels }, (_, channel) =>
        audioSourceChannelForOutput(previousChannels, channels, channel),
      );
      const history = this.history;
      const expansion = this.expansion;
      const expansionFrames = expansion[0]?.length ?? 0;
      // 左右へ広げた履歴は独立して更新される。配列を共有すると後続のステレオが混ざる。
      this.history = sources.map(
        (source) => history[source]?.slice() ?? new Float32Array(this.historyLimit),
      );
      this.expansion = sources.map(
        (source) => expansion[source]?.slice() ?? new Float32Array(expansionFrames),
      );
      this.lastOutput = Float32Array.from(sources, (source) => this.lastOutput[source] ?? 0);
      this.stopFadeValues = Float32Array.from(
        sources,
        (source) => this.stopFadeValues[source] ?? 0,
      );
      return;
    }
    // 出力は予約済みの最大チャンネル数を保つため、通常経路で減ることはない。
    // 初回の確保と、直接利用で幅を減らした場合は履歴を取り直す。
    this.history = Array.from({ length: channels }, () => new Float32Array(this.historyLimit));
    this.historyFrames = 0;
    this.historyHead = 0;
    this.expansion = [];
    this.lastOutput = new Float32Array(channels);
  }

  /** 128 サンプルに固定せず、実レンダリング量子の長さで処理する。 */
  process(
    input: readonly Float32Array[],
    output: readonly Float32Array[],
    reportedFrame: number,
  ): void {
    if (output.length !== this.history.length) this.resizeOutputChannels(output.length);
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
      if (this.stopFadeRemaining > 0) {
        const gain = --this.stopFadeRemaining / this.fadeFrames;
        for (let channel = 0; channel < output.length; channel++) {
          const samples = output[channel];
          if (samples !== undefined) samples[index] = (this.stopFadeValues[channel] ?? 0) * gain;
        }
      } else if (real) {
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
