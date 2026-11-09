import { AudioResampleKernel } from "./audioResampleKernel";

/** 予約した媒体先頭と、その時点の目標。描画するまで同期実績には使わない。 */
export interface AudioRenderPresentation {
  readonly epoch: number;
  readonly timestampMicroseconds: number;
  readonly targetPerformanceMs: number;
}

/** PCM と予約を同じメッセージで渡し、制御と実音の到着を分離しない。start は出力サンプル単位。 */
export interface AudioRenderBlock {
  readonly start: number;
  readonly sampleRate: number;
  readonly channels: readonly Float32Array[];
  readonly presentation?: AudioRenderPresentation;
}

interface QueuedBlock extends AudioRenderBlock {
  readonly end: number;
  readonly kernel: AudioResampleKernel | null;
}

/** 欠落や形式変更を越えてフィルターの材料を読み取らない。 */
function isContinuous(before: QueuedBlock, after: QueuedBlock): boolean {
  return (
    Math.abs(after.start - before.end) <= frameTolerance(before.end) &&
    before.sampleRate === after.sampleRate &&
    before.channels.length === after.channels.length
  );
}

/** 秒とサンプル位置の往復で生じる数 ULP を許し、長時間の時計でも同じ境界を使う。 */
function frameTolerance(frame: number): number {
  return Math.max(1e-7, Math.abs(frame) * Number.EPSILON * 8);
}

/** 指定時刻以降の最初の出力サンプル。整数位置の丸め誤差を 1 サンプルの穴にしない。 */
export function audioRenderFrameAtOrAfter(frame: number): number {
  return Math.ceil(frame - frameTolerance(frame));
}

/**
 * 出力数は先行予約を含む最大チャンネル数であり、少ない形式を speakers の配置へ広げる。
 * 根拠: Web Audio API §4.4 (Up Mixing Speaker Layouts)。仕様は将来変わる可能性がある。
 * 規定のない配置は discrete と同じく、入力順を維持して余りを無音にする。
 */
export function audioSourceChannelForOutput(
  inputChannels: number,
  outputChannels: number,
  channel: number,
): number {
  if (inputChannels === 1) {
    if (outputChannels === 6) return channel === 2 ? 0 : -1;
    if (outputChannels === 2 || outputChannels === 4) return channel < 2 ? 0 : -1;
  }
  if (inputChannels === 4 && outputChannels === 6)
    return channel < 2 ? channel : channel >= 4 ? channel - 2 : -1;
  return channel < inputChannels ? channel : -1;
}

/**
 * 復号フレームを連続した PCM として読む。
 *
 * フレームごとに AudioBufferSourceNode を開始・停止すると、端数サンプルの境界で
 * 補間に必要な隣のサンプルが失われる。ここでは出力時計から入力位置を求め、連続する
 * 次フレームの先頭も補間に使う。通常の境界でフェードや音の加算は行わない。
 * ダウンサンプリングは前後の予約済み PCM を使う帯域制限補間とし、追加の待機や
 * 群遅延を加えない。前後が未着なら端点を延長する。同率とアップサンプリングは
 * 線形補間を使う。形式変更・欠落の境界で別の音を混ぜない。
 */
export class AudioRenderQueue {
  private blocks: QueuedBlock[] = [];
  private head = 0;
  private kernel: AudioResampleKernel | null = null;
  private presentedBlock: QueuedBlock | null = null;

  constructor(private readonly outputRate: number) {}

  enqueue(block: AudioRenderBlock): void {
    const length = block.channels[0]?.length ?? 0;
    if (length === 0) return;
    const ratio = this.outputRate / block.sampleRate;
    if (ratio < 1 && this.kernel?.ratio !== ratio) this.kernel = new AudioResampleKernel(ratio);
    this.blocks.push({
      ...block,
      end: block.start + (length * this.outputRate) / block.sampleRate,
      kernel: ratio < 1 ? this.kernel : null,
    });
  }

  clear(): void {
    this.blocks = [];
    this.head = 0;
    this.presentedBlock = null;
  }

  /** 既に描画した PCM は解放し、未来の予約だけを保持する。 */
  process(
    output: readonly Float32Array[],
    firstFrame: number,
    onPresentation?: (block: AudioRenderBlock) => void,
  ): void {
    for (const channel of output) channel.fill(0);
    const frames = output[0]?.length ?? 0;
    for (let index = 0; index < frames; index++) {
      const frame = firstFrame + index;
      while (
        this.blocks[this.head] !== undefined &&
        frame >= (this.blocks[this.head]?.end ?? Infinity) - frameTolerance(frame)
      )
        this.head++;
      const block = this.blocks[this.head];
      if (block === undefined || frame < block.start - frameTolerance(frame)) continue;
      if (block !== this.presentedBlock) {
        this.presentedBlock = block;
        // 全体を描けた媒体先頭だけを通知する。遅れて途中から描いた音に、欠けた先頭の
        // 時刻を割り当てない。圧縮後の内部位置を線形に近似して同期精度を偽らない。
        if (block.presentation !== undefined && frame - block.start < 1 + frameTolerance(frame))
          onPresentation?.(block);
      }
      const position = Math.max(0, ((frame - block.start) * block.sampleRate) / this.outputRate);
      // 整数位置の丸め誤差で前のサンプルへ戻らない。
      const rounded = Math.round(position);
      const sourcePosition =
        Math.abs(position - rounded) < (frameTolerance(frame) * block.sampleRate) / this.outputRate
          ? rounded
          : position;
      const sourceIndex = Math.floor(sourcePosition);
      const fraction = sourcePosition - sourceIndex;
      const following = this.blocks[this.head + 1];
      const continuous = following !== undefined && isContinuous(block, following);
      for (let channel = 0; channel < output.length; channel++) {
        const sourceChannel = audioSourceChannelForOutput(
          block.channels.length,
          output.length,
          channel,
        );
        const source = block.channels[sourceChannel];
        const destination = output[channel];
        if (source === undefined || destination === undefined) continue;
        if (block.kernel !== null) {
          destination[index] = this.filteredSample(block, sourceChannel, sourceIndex, fraction);
          continue;
        }
        const before = source[sourceIndex] ?? source.at(-1) ?? 0;
        const after =
          source[sourceIndex + 1] ??
          (continuous ? following.channels[sourceChannel]?.[0] : undefined) ??
          before;
        destination[index] = before + (after - before) * fraction;
      }
    }
    // 過去の PCM はフィルターの半幅だけ残す。短いフレームが続く場合も必要な履歴を保つ。
    const historyStart = firstFrame + frames - AudioResampleKernel.OUTPUT_RADIUS - 2;
    while (this.head > 0 && (this.blocks[0]?.end ?? Infinity) < historyStart) {
      this.blocks.shift();
      this.head--;
    }
    if (this.blocks[this.head] === undefined) this.presentedBlock = null;
  }

  private filteredSample(
    block: QueuedBlock,
    channel: number,
    sourceIndex: number,
    fraction: number,
  ): number {
    const kernel = block.kernel;
    if (kernel === null) return 0;
    let blockIndex = this.head;
    let sampleIndex = sourceIndex - kernel.radius;
    // 最初のタップだけ過去へ遡り、その後はサンプル順に進む。
    while (sampleIndex < 0) {
      const previous = this.blocks[blockIndex - 1];
      if (previous === undefined || !isContinuous(previous, block)) break;
      sampleIndex += previous.channels[channel]?.length ?? 0;
      block = previous;
      blockIndex--;
    }
    let source = block.channels[channel];
    if (source === undefined) return 0;
    const phase = fraction * AudioResampleKernel.PHASES;
    const phaseIndex = Math.floor(phase);
    const phaseFraction = phase - phaseIndex;
    const weightOffset = phaseIndex * kernel.taps;
    let value = 0;
    for (let tap = 0; tap < kernel.taps; tap++, sampleIndex++) {
      while (sampleIndex >= source.length) {
        const following = this.blocks[blockIndex + 1];
        if (following === undefined || !isContinuous(block, following)) break;
        sampleIndex -= source.length;
        block = following;
        blockIndex++;
        source = block.channels[channel] ?? source;
      }
      const sample = source[Math.max(0, Math.min(sampleIndex, source.length - 1))] ?? 0;
      const weight = kernel.weights[weightOffset + tap] ?? 0;
      const nextWeight = kernel.weights[weightOffset + kernel.taps + tap] ?? 0;
      value += sample * (weight + (nextWeight - weight) * phaseFraction);
    }
    return value;
  }
}
