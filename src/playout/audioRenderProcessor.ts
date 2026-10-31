import {
  AudioRenderConcealer,
  type AudioRenderControl,
  type AudioRenderOptions,
} from "./audioRenderConcealer";
import { prepareAudioPredictor } from "./audioPredictorKernel";

// AudioWorklet 専用のグローバルだけを宣言し、メインスレッドの DOM 型へ追加しない。
declare const sampleRate: number;
declare const currentFrame: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, processor: typeof AudioRenderProcessor): void;

/** 初回の解析と予測のコンパイルを、媒体の投入前のモジュール登録時に済ませる。 */
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
prepareAudioPredictor();
prepareSignalProcessing();

/** 実音を通す処理と欠落の補間を、同じ出力時計で行う。 */
class AudioRenderProcessor extends AudioWorkletProcessor {
  private readonly concealer: AudioRenderConcealer;
  private nextReport = 0;
  private disposeFrame = Infinity;

  constructor(options: AudioWorkletNodeOptions) {
    super();
    this.concealer = new AudioRenderConcealer(
      sampleRate,
      options.processorOptions as AudioRenderOptions | undefined,
    );
    this.port.onmessage = (
      event: MessageEvent<
        AudioRenderControl | { type: "dispose"; frame: number } | { type: "synchronize" }
      >,
    ) => {
      if (event.data.type === "synchronize") {
        // 先行する制御を処理してから返す。初期化を時間待ちで推測しない。
        event.ports[0]?.postMessage(null);
        event.ports[0]?.close();
      } else if (event.data.type === "dispose") {
        this.disposeFrame = event.data.frame;
        this.concealer.control({ type: "stop", frame: event.data.frame });
      } else this.concealer.control(event.data);
    };
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    this.concealer.process(inputs[0] ?? [], outputs[0] ?? [], currentFrame);
    const finished = currentFrame >= this.disposeFrame;
    if (currentFrame >= this.nextReport || finished) {
      this.port.postMessage({
        type: "rendered",
        concealedFrames: this.concealer.concealedFrames,
        uncoveredFrames: this.concealer.uncoveredFrames,
        concealments: this.concealer.concealments,
        gaps: this.concealer.gaps,
        uncoveredMaxFrames: this.concealer.uncoveredMaxFrames,
        boundaryStepMax: this.concealer.boundaryStepMax,
        boundaryStepCount: this.concealer.boundaryStepCount,
      });
      this.nextReport = currentFrame + 1024;
    }
    if (finished) this.port.postMessage({ type: "finished" });
    return !finished;
  }
}
registerProcessor("moqt-audio-renderer", AudioRenderProcessor);
