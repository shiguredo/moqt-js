import {
  AudioRenderConcealer,
  type AudioRenderControl,
  type AudioRenderOptions,
} from "./audioRenderConcealer";
import {
  AudioRenderQueue,
  audioRenderFrameAtOrAfter,
  type AudioRenderBlock,
} from "./audioRenderQueue";

// AudioWorklet 専用のグローバルだけを宣言し、メインスレッドの DOM 型へ追加しない。
declare const sampleRate: number;
declare const currentFrame: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, processor: typeof AudioRenderProcessor): void;

/** 描画の統計を確かめる間隔 (出力サンプル数)。48 kHz で約 21 ms ごとである */
const REPORT_INTERVAL_FRAMES = 1024;

/** メインスレッドへ通知する描画の統計。すべて累積または最大であり、前回と同じなら送らない */
interface RenderedCounters {
  readonly concealedFrames: number;
  readonly uncoveredFrames: number;
  readonly concealments: number;
  readonly gaps: number;
  readonly uncoveredMaxFrames: number;
  readonly boundaryStepMax: number;
  readonly boundaryStepCount: number;
}

function sameCounters(left: RenderedCounters, right: RenderedCounters): boolean {
  return (
    left.concealedFrames === right.concealedFrames &&
    left.uncoveredFrames === right.uncoveredFrames &&
    left.concealments === right.concealments &&
    left.gaps === right.gaps &&
    left.uncoveredMaxFrames === right.uncoveredMaxFrames &&
    left.boundaryStepMax === right.boundaryStepMax &&
    left.boundaryStepCount === right.boundaryStepCount
  );
}

/** 初回の解析と予測の実行を、媒体の投入前のモジュール登録時に済ませる。 */
function prepareSignalProcessing(): void {
  const frames = Math.round(sampleRate * 0.03);
  const input = new Float32Array(frames);
  let state = 731;
  for (const mode of ["noise", "periodic", "silence"]) {
    for (let index = 0; index < frames; index++) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      input[index] =
        mode === "periodic"
          ? Math.sin((index * 2 * Math.PI * 80) / sampleRate) * 0.1
          : mode === "noise"
            ? (state / 0xffffffff - 0.5) * 0.1
            : 0;
    }
    const renderer = new AudioRenderConcealer(sampleRate, { ranges: [{ start: 0, end: frames }] });
    const output = [new Float32Array(frames), new Float32Array(frames)];
    const channels = [input, input.map((value) => -value)];
    const queue = new AudioRenderQueue(sampleRate);
    queue.enqueue({ start: 0, sampleRate, channels });
    queue.process(output, 0);
    // 実際の DSP の開始、未着、復帰を準備する。出力ノードへ接続せず、状態も引き継がない。
    renderer.process(channels, output, 0);
    const quantum = [new Float32Array(128), new Float32Array(128)];
    renderer.process([], quantum, frames);
    renderer.control({ type: "range", start: frames + 128, end: frames + 256 });
    renderer.process(
      channels.map((channel) => channel.subarray(0, 128)),
      quantum,
      frames + 128,
    );
  }
}
prepareSignalProcessing();

/** 実音を通す処理と欠落の補間を、同じ出力時計で行う。 */
class AudioRenderProcessor extends AudioWorkletProcessor {
  private readonly concealer: AudioRenderConcealer;
  private readonly queue = new AudioRenderQueue(sampleRate);
  private input: Float32Array[] = [];
  private nextFrame = 0;
  private nextReport = 0;
  private disposeFrame = Infinity;
  // 直近に通知した統計。受け側も同じ初期値から差分を取るため、0 のままの間は送らない
  private lastReported: RenderedCounters = {
    concealedFrames: 0,
    uncoveredFrames: 0,
    concealments: 0,
    gaps: 0,
    uncoveredMaxFrames: 0,
    boundaryStepMax: 0,
    boundaryStepCount: 0,
  };

  constructor(options: AudioWorkletNodeOptions) {
    super();
    this.concealer = new AudioRenderConcealer(
      sampleRate,
      options.processorOptions as AudioRenderOptions | undefined,
    );
    this.port.onmessage = (
      event: MessageEvent<
        | AudioRenderControl
        | { type: "block"; block: AudioRenderBlock }
        | { type: "dispose"; frame: number }
        | { type: "synchronize" }
      >,
    ) => {
      if (event.data.type === "synchronize") {
        // 先行する制御を処理してから返す。初期化を時間待ちで推測しない。
        event.ports[0]?.postMessage(null);
        event.ports[0]?.close();
      } else if (event.data.type === "block") {
        const block = event.data.block;
        this.queue.enqueue(block);
        this.concealer.control({
          type: "range",
          start: audioRenderFrameAtOrAfter(block.start),
          end: audioRenderFrameAtOrAfter(
            block.start + ((block.channels[0]?.length ?? 0) * sampleRate) / block.sampleRate,
          ),
          channels: block.channels.length,
        });
      } else if (event.data.type === "dispose") {
        this.disposeFrame = event.data.frame;
        this.concealer.control({ type: "stop", frame: event.data.frame });
      } else {
        if (event.data.type === "reset") this.queue.clear();
        this.concealer.control(event.data);
      }
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const output = outputs[0] ?? [];
    const frames = output[0]?.length ?? 0;
    if (this.input.length !== output.length || this.input[0]?.length !== frames)
      this.input = output.map(() => new Float32Array(frames));
    const firstFrame = Math.max(currentFrame, this.nextFrame);
    this.nextFrame = firstFrame + frames;
    this.queue.process(this.input, firstFrame);
    this.concealer.process(this.input, output, firstFrame);
    const finished = firstFrame >= this.disposeFrame && !this.concealer.fadingStop;
    if (currentFrame >= this.nextReport || finished) {
      this.nextReport = currentFrame + REPORT_INTERVAL_FRAMES;
      this.report(finished);
    }
    if (finished) this.port.postMessage({ type: "finished" });
    return !finished;
  }

  /**
   * 統計が変わったときだけメインスレッドへ通知する。
   * 欠落の無い定常状態で間隔ごとに送り続けると、音声 1 本あたり毎秒約 47 回の
   * メッセージでメインスレッドを起こすことになる。受け側は前回との差分を取るため、
   * 変わった時点の値だけで足りる。終了時は最後の値を必ず送る。
   */
  private report(force: boolean): void {
    const counters: RenderedCounters = {
      concealedFrames: this.concealer.concealedFrames,
      uncoveredFrames: this.concealer.uncoveredFrames,
      concealments: this.concealer.concealments,
      gaps: this.concealer.gaps,
      uncoveredMaxFrames: this.concealer.uncoveredMaxFrames,
      boundaryStepMax: this.concealer.boundaryStepMax,
      boundaryStepCount: this.concealer.boundaryStepCount,
    };
    if (!force && sameCounters(counters, this.lastReported)) return;
    this.lastReported = counters;
    this.port.postMessage({ type: "rendered", ...counters });
  }
}
registerProcessor("moqt-audio-renderer", AudioRenderProcessor);
