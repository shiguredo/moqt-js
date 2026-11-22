/** 実描画した出力サンプルの整数半開区間。媒体時刻は先頭の位置で、未知の区間は通知しない。 */
export interface AudioRenderedPositionSpan {
  readonly epoch: number;
  readonly firstFrame: number;
  readonly endFrame: number;
  readonly timestampMicroseconds: number;
  readonly kind: "real" | "concealed";
}

/** 端数を含む実音の開始位置と、対応する媒体時刻。出力レートで媒体位置へ換算する。 */
export interface AudioRenderMediaAnchor {
  readonly epoch: number;
  readonly frame: number;
  readonly timestampMicroseconds: number;
}

export type AudioRenderPositionSource = AudioRenderMediaAnchor | "concealed" | null;

type PendingPositionSpan = Omit<AudioRenderedPositionSpan, "endFrame"> & { endFrame: number };
export const EMPTY_AUDIO_RENDERED_POSITIONS: readonly AudioRenderedPositionSpan[] = [];

/**
 * 未加工の実音から得た媒体位置だけを、直後の連続した予測音へ延ばす。
 * 出力座標で連続していない区間や、媒体時刻を持たない描画は推定を失効させる。
 * 同じ対応の区間をまとめ、算術と割り当てを描画サンプルごとに行わない。
 */
export class AudioRenderPosition {
  private readonly microsecondsPerFrame: number;
  private anchor: AudioRenderMediaAnchor | null = null;
  private endFrame: number | null = null;
  private pending: PendingPositionSpan[] = [];
  private pendingAnchor: AudioRenderMediaAnchor | null = null;

  constructor(sampleRate: number) {
    this.microsecondsPerFrame = 1_000_000 / sampleRate;
  }

  record(source: AudioRenderPositionSource, firstFrame: number, endFrame: number): void {
    if (firstFrame >= endFrame) return;
    const anchor =
      source === "concealed" ? (firstFrame === this.endFrame ? this.anchor : null) : source;
    this.anchor = anchor;
    this.endFrame = endFrame;
    if (anchor === null) return;

    const kind = source === "concealed" ? "concealed" : "real";
    const timestampMicroseconds =
      anchor.timestampMicroseconds + (firstFrame - anchor.frame) * this.microsecondsPerFrame;
    const previous = this.pending.at(-1);
    if (
      previous !== undefined &&
      previous.endFrame === firstFrame &&
      previous.epoch === anchor.epoch &&
      previous.kind === kind &&
      (this.pendingAnchor === anchor ||
        previous.timestampMicroseconds +
          (firstFrame - previous.firstFrame) * this.microsecondsPerFrame ===
          timestampMicroseconds)
    ) {
      previous.endFrame = endFrame;
      return;
    }
    this.pending.push({ epoch: anchor.epoch, firstFrame, endFrame, timestampMicroseconds, kind });
    this.pendingAnchor = anchor;
  }

  /** 通知を取り出しても、次の量子に続く補間の基準は保持する。 */
  takePositions(): readonly AudioRenderedPositionSpan[] {
    if (this.pending.length === 0) return EMPTY_AUDIO_RENDERED_POSITIONS;
    const spans = this.pending;
    this.pending = [];
    this.pendingAnchor = null;
    return spans;
  }

  reset(): void {
    this.pending = [];
    this.pendingAnchor = null;
    this.anchor = null;
    this.endFrame = null;
  }
}
