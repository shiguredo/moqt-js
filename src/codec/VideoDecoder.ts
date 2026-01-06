/**
 * ビデオデコーダーラッパー
 *
 * Worker モードと直接実行モードを抽象化する
 */

import type { VideoCodecType, VideoDecoderWrapperCallbacks } from "./types";
import { getVideoDecoderConfig } from "./config";

/**
 * ビデオデコーダーラッパークラス
 */
export class VideoDecoderWrapper {
  private useWorker: boolean;
  private decoder: VideoDecoder | null = null;
  private worker: Worker | null = null;
  private callbacks: VideoDecoderWrapperCallbacks;
  private configured = false;
  // 直接モード用: キーフレーム待ちフラグ
  private needsKeyframe = true;
  private lastConfig: VideoDecoderConfig | null = null;

  constructor(useWorker: boolean, callbacks: VideoDecoderWrapperCallbacks) {
    this.useWorker = useWorker;
    this.callbacks = callbacks;
  }

  /**
   * デコーダーを設定する
   */
  async configure(
    codec: VideoCodecType,
    width: number,
    height: number,
    description?: Uint8Array,
  ): Promise<void> {
    const config = getVideoDecoderConfig(codec, width, height, description);
    this.lastConfig = config;

    if (this.useWorker) {
      await this.configureWorker(config);
    } else {
      await this.configureDirect(config);
    }
    this.configured = true;
  }

  private async configureWorker(config: VideoDecoderConfig): Promise<void> {
    const WorkerModule = await import("./workers/videoDecoder.worker?worker");
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
              frame: message.frame,
            });
            break;
          case "skipped":
            // キーフレーム待ちでスキップされたフレームは無視
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

  private async configureDirect(config: VideoDecoderConfig): Promise<void> {
    // 新しいデコーダーはキーフレームを必要とする
    this.needsKeyframe = true;

    this.decoder = new VideoDecoder({
      output: (frame: VideoFrame) => {
        this.callbacks.output({
          frame,
        });
      },
      error: (error: DOMException) => {
        this.callbacks.error(new Error(error.message));
      },
    });

    this.decoder.configure(config);
  }

  /**
   * エンコードされたビデオチャンクをデコードする
   */
  decode(data: Uint8Array, type: "key" | "delta", timestamp: number, duration: number): void {
    if (!this.configured) {
      console.warn("VideoDecoderWrapper: not configured");
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
      // キーフレームが必要な状態でデルタフレームを受信した場合はスキップ
      if (this.needsKeyframe && type !== "key") {
        return;
      }

      // キーフレームを受信したらフラグをリセット
      if (type === "key") {
        this.needsKeyframe = false;
      }

      const chunk = new EncodedVideoChunk({
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
   * キーフレーム待ち状態にリセットする
   */
  resetKeyframeWait(): void {
    if (this.useWorker && this.worker) {
      this.worker.postMessage({ type: "resetKeyframeWait" });
    } else {
      this.needsKeyframe = true;
    }
  }

  /**
   * エラー後にデコーダーをリセットする
   */
  async reset(): Promise<void> {
    if (!this.lastConfig) {
      console.warn("VideoDecoderWrapper: cannot reset without config");
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
