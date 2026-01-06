/**
 * オーディオエンコーダーラッパー
 *
 * Worker モードと直接実行モードを抽象化する
 */

import type { AudioCodecType, AudioEncoderWrapperCallbacks } from "./types";
import { getAudioEncoderConfig } from "./config";

/**
 * オーディオエンコーダーラッパークラス
 */
export class AudioEncoderWrapper {
  private useWorker: boolean;
  private encoder: AudioEncoder | null = null;
  private worker: Worker | null = null;
  private callbacks: AudioEncoderWrapperCallbacks;
  private configured = false;

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
    // Vite の Worker インポートを使用
    const WorkerModule = await import("./workers/audioEncoder.worker?worker");
    this.worker = new WorkerModule.default();

    return new Promise((resolve, reject) => {
      if (!this.worker) {
        reject(new Error("worker not initialized"));
        return;
      }

      this.worker.onmessage = (event: MessageEvent) => {
        const message = event.data;

        switch (message.type) {
          case "configured":
            resolve();
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
            this.callbacks.error(new Error(message.message));
            break;
        }
      };

      this.worker.onerror = (event) => {
        this.callbacks.error(new Error(event.message));
      };

      this.worker.postMessage({
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
    if (this.useWorker && this.worker) {
      this.worker.postMessage({ type: "close" });
      this.worker.terminate();
      this.worker = null;
    } else if (this.encoder) {
      this.encoder.close();
      this.encoder = null;
    }
    this.configured = false;
  }
}
