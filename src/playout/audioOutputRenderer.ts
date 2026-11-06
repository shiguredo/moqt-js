// URL クエリは変換後に既定 export を持つ。元のプロセッサーをメインスレッドで実行しない。
// eslint-disable-next-line import/default
import processorUrl from "./audioRenderProcessor.ts?worker&url";
import type { AudioPlayoutOutput } from "./audioPlayoutSession";
import type { AudioRenderControl } from "./audioRenderConcealer";
import type { AudioSamples } from "./audioTimeStretch";
import { audioRenderFrameAtOrAfter } from "./audioRenderQueue";

/** 自動再生や停止との競合で resume が失敗しても、通知の失敗を未処理の rejection にしない。 */
export function resumeAudioOutput(context: AudioContext, notify: (error: Error) => void): void {
  void context.resume().catch((error: unknown) => {
    try {
      notify(error instanceof Error ? error : new Error(String(error)));
    } catch {
      /* 通知を再度失敗させる経路は作らない。 */
    }
  });
}

export interface AudioRenderStatistics {
  readonly type: "rendered";
  readonly concealedFrames: number;
  readonly uncoveredFrames: number;
  readonly concealments: number;
  readonly gaps: number;
  readonly uncoveredMaxFrames: number;
  readonly boundaryStepMax: number;
  readonly boundaryStepCount: number;
}

/**
 * 準備で実出力の時計が動き出すまで待つ上限 (ミリ秒)
 *
 * 通常は数ミリ秒で動き出すが、headless Chrome を CPU 負荷の高い環境で動かすと、出力の
 * レンダリングが始まるまで 1 秒を超えることがある (Apple Silicon のローカルで E2E 全体を
 * 1 ブラウザーで連続実行し、CPU 負荷を 8 本かけたときに 1000 ms では足りず失敗した)。
 * CI の runner はさらに遅いため余裕を持たせる。動き出した時点で待ちを抜けるため、通常の
 * 待ち時間は増えない
 */
const AUDIO_OUTPUT_CLOCK_START_WAIT_MS = 3_000;

const preparations = new WeakMap<BaseAudioContext, { promise: Promise<void>; ready: boolean }>();

/** 同じ Context にモジュールを重複登録しない。失敗も共有し、無限に再試行しない。 */
function prepareContext(context: BaseAudioContext): Promise<void> {
  let preparation = preparations.get(context);
  if (preparation === undefined) {
    const state = { promise: Promise.resolve(), ready: false };
    state.promise = context.audioWorklet.addModule(processorUrl).then(() => {
      state.ready = true;
    });
    preparations.set(context, state);
    preparation = state;
  }
  return preparation.promise;
}

/**
 * 通常音の予約先を固定し、AudioWorklet の準備と終了を所有する。
 * prepare() が完了してから予約する。準備中だけ別の音声経路を使うことはしない。
 * 再生のタイマーは持たず、補間と停止は出力時計のサンプル位置で処理する。
 */
export class AudioOutputRenderer {
  private readonly context: BaseAudioContext;
  private node: AudioWorkletNode | null = null;
  private readonly preparation: Promise<void>;
  private stopFrame = Infinity;
  private disposing = false;
  private failure: Error | null = null;
  private lastStatistics: AudioRenderStatistics = {
    type: "rendered",
    concealedFrames: 0,
    uncoveredFrames: 0,
    concealments: 0,
    gaps: 0,
    uncoveredMaxFrames: 0,
    boundaryStepMax: 0,
    boundaryStepCount: 0,
  };

  constructor(
    readonly output: AudioPlayoutOutput,
    private readonly onRendered: (statistics: AudioRenderStatistics) => void,
  ) {
    this.context = output.destination.context;
    if (preparations.get(this.context)?.ready === true) {
      this.activate();
      this.preparation = Promise.resolve();
    } else
      this.preparation = prepareContext(this.context)
        .then(() => this.activate())
        .catch((error: unknown) => {
          this.failure = error instanceof Error ? error : new Error(String(error));
          throw this.failure;
        });
    // 同期 API の利用でも未処理の rejection は残さない。prepare は元の失敗を返す。
    void this.preparation.catch(() => {});
  }

  private activate(): void {
    if (this.context.state === "closed") return;
    const node = new AudioWorkletNode(this.context, "moqt-audio-renderer", {
      channelCountMode: "explicit",
      channelCount: 1,
      processorOptions: { stopFrame: this.stopFrame },
    });
    // Firefox は未接続の入力では出力を 1 チャンネルに保つため、無音の実入力を接続する。
    // 実音は Worklet 内の PCM からだけ作る。入力はチャンネル配置の伝播にだけ使う。
    const layoutSource = this.context.createConstantSource();
    layoutSource.offset.value = 0;
    layoutSource.connect(node);
    layoutSource.start();
    let disconnected = false;
    const disconnect = (): void => {
      if (disconnected) return;
      disconnected = true;
      layoutSource.stop();
      layoutSource.disconnect();
      node.disconnect();
      node.port.close();
    };
    node.onprocessorerror = () => {
      this.failure = new Error("Audio render processor failed");
      disconnect();
    };
    node.port.onmessage = (event: MessageEvent<AudioRenderStatistics | { type: "finished" }>) => {
      if (event.data.type === "finished") {
        disconnect();
        return;
      }
      const statistics = event.data;
      this.onRendered({
        type: "rendered",
        concealedFrames: statistics.concealedFrames - this.lastStatistics.concealedFrames,
        uncoveredFrames: statistics.uncoveredFrames - this.lastStatistics.uncoveredFrames,
        concealments: statistics.concealments - this.lastStatistics.concealments,
        gaps: statistics.gaps - this.lastStatistics.gaps,
        uncoveredMaxFrames: statistics.uncoveredMaxFrames,
        boundaryStepMax: statistics.boundaryStepMax,
        boundaryStepCount: statistics.boundaryStepCount - this.lastStatistics.boundaryStepCount,
      });
      this.lastStatistics = statistics;
    };
    this.node = node;
    node.connect(this.output.destination);
    if (this.disposing) node.port.postMessage({ type: "dispose", frame: this.stopFrame });
  }

  async prepare(): Promise<void> {
    await this.preparation;
    if (this.context.state === "closed")
      throw new Error("Audio output context closed during preparation");
    await this.synchronize();
    if (
      typeof this.output.context.getOutputTimestamp !== "function" ||
      this.context.state !== "running"
    )
      return;
    // 動き始めの暫定時計で最初の予約を固定すると、実時計への切り替え分が後続にも残る。
    // 音声を投入する前の準備でだけ待つ。再生中の取り出しにタイマーは使わない。
    const deadline = performance.now() + AUDIO_OUTPUT_CLOCK_START_WAIT_MS;
    while (this.context.state === "running") {
      const timestamp = this.output.context.getOutputTimestamp();
      if ((timestamp.contextTime ?? 0) > 0 && (timestamp.performanceTime ?? 0) > 0) return;
      if (performance.now() >= deadline)
        throw new Error(
          `Audio output clock did not start within ${AUDIO_OUTPUT_CLOCK_START_WAIT_MS} ms`,
        );
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 4);
      });
    }
  }

  /** 登録の完了と、プロセッサーが先行する制御を受理したことを区別する。 */
  private synchronize(): Promise<void> {
    this.assertReady();
    return new Promise<void>((resolve, reject) => {
      const channel = new MessageChannel();
      const timeout = setTimeout(() => {
        channel.port1.close();
        reject(this.failure ?? new Error("Audio render processor did not respond within 1000 ms"));
      }, 1000);
      channel.port1.onmessage = () => {
        clearTimeout(timeout);
        channel.port1.close();
        if (this.failure === null) resolve();
        else reject(this.failure);
      };
      this.node?.port.postMessage({ type: "synchronize" }, [channel.port2]);
    });
  }

  enqueue(
    startSeconds: number,
    channels: readonly AudioSamples[],
    sampleRate: number,
    draining: boolean,
  ): void {
    this.assertReady();
    // 後続のモノラル予約で、まだ鳴っているステレオを先にダウンミックスしない。
    if (this.node !== null && this.node.channelCount < channels.length)
      this.node.channelCount = channels.length;
    if (Number.isFinite(this.stopFrame) && !draining) {
      this.send({ type: "reset" });
      this.stopFrame = Infinity;
    }
    const endFrame =
      (startSeconds + (channels[0]?.length ?? 0) / sampleRate) * this.context.sampleRate;
    if (Number.isFinite(this.stopFrame))
      this.stopFrame = Math.max(this.stopFrame, audioRenderFrameAtOrAfter(endFrame));
    // 前の PCM は伸長の履歴としてメインスレッドにも残る。コピーだけを transfer する。
    const samples = channels.map((channel) => new Float32Array(channel));
    this.node?.port.postMessage(
      {
        type: "block",
        block: {
          start: startSeconds * this.context.sampleRate,
          sampleRate,
          channels: samples,
        },
      },
      samples.map((channel) => channel.buffer),
    );
  }

  assertReady(): void {
    if (this.failure !== null) throw this.failure;
    if (this.context.state === "closed") throw new Error("Audio output context is closed");
    if (this.node === null)
      throw new Error("Audio output is not prepared: await prepareAudio() before pushAudio()");
    if (this.disposing) throw new Error("Audio output renderer is disposed");
  }

  stop(endSeconds: number): void {
    // drain のポーリングで、既に止めた予測音を未来へ延長して再開しない。
    this.stopFrame = Math.min(
      this.stopFrame,
      audioRenderFrameAtOrAfter(endSeconds * this.context.sampleRate),
    );
    this.send({ type: "stop", frame: this.stopFrame });
  }
  dispose(endSeconds: number): void {
    this.disposing = true;
    this.stop(endSeconds);
    this.node?.port.postMessage({ type: "dispose", frame: this.stopFrame });
  }
  private send(control: AudioRenderControl): void {
    this.node?.port.postMessage(control);
  }
}
