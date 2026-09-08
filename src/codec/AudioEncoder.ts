/**
 * オーディオエンコーダーラッパー
 *
 * Worker モードと直接実行モードを抽象化する
 */

import type { AudioCodecType, AudioEncoderWrapperCallbacks } from "./types";
import { getAudioEncoderConfig } from "./config";
import {
  ConfigureGenerationTracker,
  WorkerConfigureGate,
  disposeWorker,
  toFailureMessage,
} from "./workerConfigure";

/**
 * オーディオエンコーダーラッパークラス
 */
export class AudioEncoderWrapper {
  private useWorker: boolean;
  private encoder: AudioEncoder | null = null;
  private worker: Worker | null = null;
  private callbacks: AudioEncoderWrapperCallbacks;
  private configured = false;
  // configure() 発行ごとの世代管理 (並行 configure の所有権分離用)
  private readonly generationTracker = new ConfigureGenerationTracker();

  constructor(useWorker: boolean, callbacks: AudioEncoderWrapperCallbacks) {
    this.useWorker = useWorker;
    this.callbacks = callbacks;
  }

  /**
   * エンコーダーを設定する
   */
  async configure(
    codec: AudioCodecType,
    bitrate: number,
    sampleRate?: number,
    channels?: number,
  ): Promise<void> {
    const config = getAudioEncoderConfig(codec, bitrate, sampleRate, channels);

    if (this.useWorker) {
      await this.configureWorker(config);
    } else {
      await this.configureDirect(config);
    }
    this.configured = true;
  }

  private async configureWorker(config: AudioEncoderConfig): Promise<void> {
    // 世代採番は待機より前 (動的 import の解決順に依存させない)。
    // 生成した worker と世代を対応付ける。
    // import 失敗時は世代のみ消費する空番になるが、isLatest() は公開時のみ
    // 参照するため無害である。
    const generation = this.generationTracker.begin();
    const WorkerModule = await import("./workers/audioEncoder.worker?worker");
    // 待機中に旧世代化した場合は Worker を生成せず離脱する (生成の無駄を省く)
    if (!this.generationTracker.isLatest(generation)) {
      throw new Error("worker configure superseded by newer generation");
    }
    // 生成直後に局所変数へ捕捉する (共有フィールドに置かない)。
    // 並行 configure() の世代分離のため、以降は局所参照のみ使う。
    const worker = new WorkerModule.default();

    return new Promise((resolve, reject) => {
      if (!worker) {
        reject(new Error("worker not initialized"));
        return;
      }

      // 初期化完了前の "error" は configure() の reject とし、
      // 完了後の "error" は従来どおり通知する (二重解決ガード付き)
      const gate = new WorkerConfigureGate();
      const failConfigure = (error: Error) => {
        if (gate.trySettle()) {
          // 失敗した自世代のみ破棄する (他世代の Worker には触らない)
          disposeWorker(worker);
          reject(error);
        } else {
          this.callbacks.error(error);
        }
      };

      worker.onmessage = (event: MessageEvent) => {
        const message = event.data;

        switch (message.type) {
          case "configured":
            if (gate.trySettle()) {
              if (this.generationTracker.isLatest(generation)) {
                // 最新世代: 旧公開を破棄して公開する (後勝ち)
                const previous = this.worker;
                this.worker = worker;
                disposeWorker(previous);
                resolve();
              } else {
                // 旧世代の遅延成功: 自世代を破棄する (先発破棄)
                disposeWorker(worker);
                reject(new Error("worker configure superseded by newer generation"));
              }
            }
            break;
          case "encoded":
            this.callbacks.output({
              data: new Uint8Array(message.data),
              type: message.chunkType,
              timestamp: message.timestamp,
              duration: message.duration,
            });
            break;
          case "error":
            failConfigure(new Error(toFailureMessage(message.message)));
            break;
        }
      };

      worker.onerror = (event) => {
        failConfigure(new Error(toFailureMessage(event.message)));
      };

      worker.postMessage({
        type: "init",
        config,
      });
    });
  }

  private async configureDirect(config: AudioEncoderConfig): Promise<void> {
    this.encoder = new AudioEncoder({
      output: (chunk: EncodedAudioChunk) => {
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);

        this.callbacks.output({
          data,
          type: chunk.type,
          timestamp: chunk.timestamp,
          duration: chunk.duration,
        });
      },
      error: (error: DOMException) => {
        this.callbacks.error(new Error(error.message));
      },
    });

    this.encoder.configure(config);
  }

  /**
   * オーディオデータをエンコードする
   */
  encode(audioData: AudioData): void {
    if (!this.configured) {
      console.warn("AudioEncoderWrapper: not configured");
      return;
    }

    // 公開中の最新世代に送る (待機中の未公開世代には送らない)。
    // 再 configure() 待機中は旧公開が受け、公開切り替え後に新世代へ切り替わる。
    if (this.useWorker && this.worker) {
      // Worker モードでは audioData を transfer する
      this.worker.postMessage(
        {
          type: "encode",
          data: audioData,
        },
        [audioData],
      );
    } else if (this.encoder && this.encoder.state === "configured") {
      this.encoder.encode(audioData);
    }
  }

  /**
   * エンコーダーの状態を取得する
   */
  get state(): string {
    if (this.useWorker) {
      return this.configured ? "configured" : "unconfigured";
    }
    return this.encoder?.state ?? "unconfigured";
  }

  /**
   * エンコードキューのサイズを取得する
   */
  get encodeQueueSize(): number {
    if (this.useWorker) {
      // Worker モードでは直接取得できない
      return 0;
    }
    return this.encoder?.encodeQueueSize ?? 0;
  }

  /**
   * エンコーダーを閉じる
   */
  close(): void {
    // 待機中の configure 世代を無効化する。
    // 遅延成功した旧世代は破棄・reject される (中断扱い)。
    this.generationTracker.invalidateAll();
    if (this.useWorker && this.worker) {
      const closing = this.worker;
      this.worker = null;
      disposeWorker(closing);
    } else if (this.encoder) {
      this.encoder.close();
      this.encoder = null;
    }
    this.configured = false;
  }
}
