import type { AudioRenderedPositionSpan } from "./audioRenderPosition";

/** 出力時計の位置に対応する音声の媒体時刻。補間は元の音声を観測したものではない。 */
export interface AudioOutputMediaPosition {
  readonly kind: "real" | "concealed";
  readonly timestampMicroseconds: number;
}

/** 同じ提示時刻で照合した差と、照合に使った音声位置の根拠。 */
export interface AudioOutputSkew {
  readonly skewMs: number;
  readonly audioKind: AudioOutputMediaPosition["kind"];
}

// 出力時計の先行量と直近の映像の照合に必要な範囲だけ保持する。件数でも制限する。
export const AUDIO_OUTPUT_HISTORY_MS = 250;
const MAX_HISTORY_SPANS = 256;

/** 実際に描画した出力サンプル範囲だけを保持する。未知の区間を補外しない。 */
export class AudioOutputSync {
  private spans: AudioRenderedPositionSpan[] = [];
  private epoch: number | null = null;
  private firstUsableFrame = 0;
  private readonly microsecondsPerFrame: number;
  private readonly historyFrames: number;

  constructor(outputSampleRate: number) {
    this.microsecondsPerFrame = 1_000_000 / outputSampleRate;
    this.historyFrames = (AUDIO_OUTPUT_HISTORY_MS * outputSampleRate) / 1000;
  }

  record(spans: readonly AudioRenderedPositionSpan[], epoch: number): void {
    if (this.epoch !== epoch) {
      this.spans.length = 0;
      this.epoch = epoch;
    }
    for (const span of spans) {
      if (span.epoch !== epoch || span.firstFrame < this.firstUsableFrame) continue;
      const previous = this.spans.at(-1);
      if (span.firstFrame < (previous?.endFrame ?? 0)) continue;
      // 時計を取り直した後や通知が欠けた後は、同じ出力時計で確認した実音から再開する。
      // 1 マイクロ秒の幅は、epoch からの時刻への換算で生じる丸めを吸収する。
      if (
        span.kind === "concealed" &&
        (previous === undefined ||
          previous.endFrame !== span.firstFrame ||
          Math.abs(this.timestampAt(previous, previous.endFrame) - span.timestampMicroseconds) > 1)
      )
        continue;
      this.spans.push(span);
    }
    const last = this.spans.at(-1);
    if (last === undefined) return;
    const earliestFrame = last.endFrame - this.historyFrames;
    while (
      this.spans.length > MAX_HISTORY_SPANS ||
      (this.spans[0]?.endFrame ?? Infinity) <= earliestFrame
    )
      this.spans.shift();
  }

  positionAt(frame: number, epoch: number): AudioOutputMediaPosition | null {
    if (epoch !== this.epoch || !Number.isFinite(frame)) return null;
    for (let index = this.spans.length - 1; index >= 0; index--) {
      const span = this.spans[index];
      if (span === undefined || frame < span.firstFrame) continue;
      if (frame >= span.endFrame) return null;
      return { kind: span.kind, timestampMicroseconds: this.timestampAt(span, frame) };
    }
    return null;
  }

  /** 同じ Context で再基準化したとき、遅れて届く古い描画通知を取り込まない。 */
  clear(firstUsableFrame: number): void {
    this.spans.length = 0;
    this.epoch = null;
    this.firstUsableFrame = Math.max(this.firstUsableFrame, firstUsableFrame);
  }

  private timestampAt(span: AudioRenderedPositionSpan, frame: number): number {
    return span.timestampMicroseconds + (frame - span.firstFrame) * this.microsecondsPerFrame;
  }
}

/** 選択する周期の目標だけを補正する。共有予算や映像のフレームの期限は書き換えない。 */
export function videoSelectionTargetMs(
  baseTargetMs: number,
  audioMediaPresentationMs: number | null,
  refreshMs: number,
): number {
  if (audioMediaPresentationMs === null) return baseTargetMs;
  const limitMs = Math.min(refreshMs / 2, 20);
  const correctionMs = audioMediaPresentationMs - baseTargetMs;
  return baseTargetMs + Math.max(-limitMs, Math.min(limitMs, correctionMs));
}
