/** PCM と予約を同じメッセージで渡し、制御と実音の到着を分離しない。start は出力サンプル単位。 */
export interface AudioRenderBlock {
  readonly start: number;
  readonly sampleRate: number;
  readonly channels: readonly Float32Array[];
}

interface QueuedBlock extends AudioRenderBlock {
  readonly end: number;
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
 * レート変換は Chromium の AudioBufferSourceNode と同様の線形補間を使う。
 * 根拠: Chromium audio_buffer_source_handler.cc の ProcessInterpolatedPath。
 * ブラウザー側の方式は変更され得るため、互換性は実出力との比較でも検証する。
 */
export class AudioRenderQueue {
  private blocks: QueuedBlock[] = [];

  constructor(private readonly outputRate: number) {}

  enqueue(block: AudioRenderBlock): void {
    const length = block.channels[0]?.length ?? 0;
    if (length === 0) return;
    this.blocks.push({
      ...block,
      end: block.start + (length * this.outputRate) / block.sampleRate,
    });
  }

  clear(): void {
    this.blocks = [];
  }

  /** 既に描画した PCM は解放し、未来の予約だけを保持する。 */
  process(output: readonly Float32Array[], firstFrame: number): void {
    for (const channel of output) channel.fill(0);
    const frames = output[0]?.length ?? 0;
    for (let index = 0; index < frames; index++) {
      const frame = firstFrame + index;
      while (this.blocks[0] !== undefined && frame >= this.blocks[0].end - frameTolerance(frame))
        this.blocks.shift();
      const block = this.blocks[0];
      if (block === undefined || frame < block.start - frameTolerance(frame)) continue;
      const position = Math.max(0, ((frame - block.start) * block.sampleRate) / this.outputRate);
      // 整数位置の丸め誤差で前のサンプルへ戻らない。
      const rounded = Math.round(position);
      const sourcePosition =
        Math.abs(position - rounded) < (frameTolerance(frame) * block.sampleRate) / this.outputRate
          ? rounded
          : position;
      const sourceIndex = Math.floor(sourcePosition);
      const fraction = sourcePosition - sourceIndex;
      const following = this.blocks[1];
      const continuous =
        following !== undefined &&
        Math.abs(following.start - block.end) <= frameTolerance(block.end) &&
        following.sampleRate === block.sampleRate &&
        following.channels.length === block.channels.length;
      for (let channel = 0; channel < output.length; channel++) {
        const sourceChannel = audioSourceChannelForOutput(
          block.channels.length,
          output.length,
          channel,
        );
        const source = block.channels[sourceChannel];
        const destination = output[channel];
        if (source === undefined || destination === undefined) continue;
        const before = source[sourceIndex] ?? source.at(-1) ?? 0;
        const after =
          source[sourceIndex + 1] ??
          (continuous ? following.channels[sourceChannel]?.[0] : undefined) ??
          before;
        destination[index] = before + (after - before) * fraction;
      }
    }
  }
}
