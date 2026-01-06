/**
 * オーディオデコーダーラッパー
 *
 * Worker モードと直接実行モードを抽象化する
 */

import type { AudioCodecType, AudioDecoderWrapperCallbacks } from "./types";
import { getAudioDecoderConfig } from "./config";

/**
 * オーディオデコーダーラッパークラス
 */
export class AudioDecoderWrapper {
  private useWorker: boolean;
  private decoder: AudioDecoder | null = null;
  private worker: Worker | null = null;
  private callbacks: AudioDecoderWrapperCallbacks;
  private configured = false;
  private lastConfig: AudioDecoderConfig | null = null;

  constructor(useWorker: boolean, callbacks: AudioDecoderWrapperCallbacks) {
    this.useWorker = useWorker;
    this.callbacks = callbacks;
  }

  /**
   * デコーダーを設定する
   */
  async configure(codec: AudioCodecType, sampleRate?: number, channels?: number): Promise<void> {
    const config = getAudioDecoderConfig(codec, sampleRate, channels);
    this.lastConfig = config;

    if (this.useWorker) {
      await this.configureWorker(config);
    } else {
      await this.configureDirect(config);
    }
    this.configured = true;
  }

  private async configureWorker(config: AudioDecoderConfig): Promise<void> {
    const WorkerModule = await import("./workers/audioDecoder.worker?worker");
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
          case "decoded":
            this.callbacks.output({
              data: message.data,
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

  private async configureDirect(config: AudioDecoderConfig): Promise<void> {
    this.decoder = new AudioDecoder({
      output: (audioData: AudioData) => {
        this.callbacks.output({
          data: audioData,
        });
      },
      error: (error: DOMException) => {
        this.callbacks.error(new Error(error.message));
      },
    });

    this.decoder.configure(config);
  }

  /**
   * エンコードされたオーディオチャンクをデコードする
   */
  decode(data: Uint8Array, type: "key" | "delta", timestamp: number, duration: number): void {
    if (!this.configured) {
      console.warn("AudioDecoderWrapper: not configured");
      return;
    }

    if (this.useWorker && this.worker) {
      const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      this.worker.postMessage(
        {
          type: "decode",
          data: buffer,
          chunkType: type,
          timestamp,
          duration,
        },
        [buffer],
      );
    } else if (this.decoder && this.decoder.state === "configured") {
      const chunk = new EncodedAudioChunk({
        type,
        timestamp,
        duration,
        data,
      });
      try {
        this.decoder.decode(chunk);
      } catch (error) {
        this.callbacks.error(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  /**
   * デコーダーの状態を取得する
   */
  get state(): string {
    if (this.useWorker) {
      return this.configured ? "configured" : "unconfigured";
    }
    return this.decoder?.state ?? "unconfigured";
  }

  /**
   * エラー後にデコーダーをリセットする
   */
  async reset(): Promise<void> {
    if (!this.lastConfig) {
      console.warn("AudioDecoderWrapper: cannot reset without config");
      return;
    }

    // 現在のデコーダーをクリーンアップ
    if (this.useWorker && this.worker) {
      this.worker.postMessage({ type: "close" });
      this.worker.terminate();
      this.worker = null;
    } else if (this.decoder) {
      if (this.decoder.state !== "closed") {
        this.decoder.close();
      }
      this.decoder = null;
    }

    this.configured = false;

    // 再初期化
    if (this.useWorker) {
      await this.configureWorker(this.lastConfig);
    } else {
      await this.configureDirect(this.lastConfig);
    }
    this.configured = true;
  }

  /**
   * デコーダーを閉じる
   */
  close(): void {
    if (this.useWorker && this.worker) {
      this.worker.postMessage({ type: "close" });
      this.worker.terminate();
      this.worker = null;
    } else if (this.decoder) {
      if (this.decoder.state !== "closed") {
        this.decoder.close();
      }
      this.decoder = null;
    }
    this.configured = false;
  }
}
