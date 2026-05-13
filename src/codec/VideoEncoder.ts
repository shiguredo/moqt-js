/**
 * ビデオエンコーダーラッパー
 *
 * Worker モードと直接実行モードを抽象化する
 */

import type { VideoCodecType, VideoEncoderWrapperCallbacks } from "./types";
import { getVideoEncoderConfig } from "./config";

/**
 * ビデオエンコーダーラッパークラス
 */
export class VideoEncoderWrapper {
  private useWorker: boolean;
  private encoder: VideoEncoder | null = null;
  private worker: Worker | null = null;
  private callbacks: VideoEncoderWrapperCallbacks;
  private configured = false;

  constructor(useWorker: boolean, callbacks: VideoEncoderWrapperCallbacks) {
    this.useWorker = useWorker;
    this.callbacks = callbacks;
  }

  /**
   * エンコーダーを設定する
   */
  async configure(
    codec: VideoCodecType,
    width: number,
    height: number,
    bitrate: number,
    framerate: number,
  ): Promise<void> {
    const config = getVideoEncoderConfig(codec, width, height, bitrate, framerate);

    if (this.useWorker) {
      await this.configureWorker(config);
    } else {
      await this.configureDirect(config);
    }
    this.configured = true;
  }

  private async configureWorker(config: VideoEncoderConfig): Promise<void> {
    const WorkerModule = await import("./workers/videoEncoder.worker?worker");
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
              description: message.description ? new Uint8Array(message.description) : undefined,
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

  private async configureDirect(config: VideoEncoderConfig): Promise<void> {
    this.encoder = new VideoEncoder({
      output: (chunk: EncodedVideoChunk, metadata?: EncodedVideoChunkMetadata) => {
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);

        let description: Uint8Array | undefined;
        if (metadata?.decoderConfig?.description) {
          const desc = metadata.decoderConfig.description;
          if (desc instanceof ArrayBuffer) {
            description = new Uint8Array(desc);
          } else if (ArrayBuffer.isView(desc)) {
            description = new Uint8Array(desc.buffer, desc.byteOffset, desc.byteLength);
          }
        }

        this.callbacks.output({
          data,
          type: chunk.type,
          timestamp: chunk.timestamp,
          duration: chunk.duration,
          description,
        });
      },
      error: (error: DOMException) => {
        this.callbacks.error(new Error(error.message));
      },
    });

    this.encoder.configure(config);
  }

  /**
   * ビデオフレームをエンコードする
   */
  encode(frame: VideoFrame, options?: VideoEncoderEncodeOptions): void {
    if (!this.configured) {
      console.warn("VideoEncoderWrapper: not configured");
      return;
    }

    if (this.useWorker && this.worker) {
      // Worker モードでは frame を transfer する
      this.worker.postMessage(
        {
          type: "encode",
          frame,
          keyFrame: options?.keyFrame ?? false,
        },
        [frame],
      );
    } else if (this.encoder && this.encoder.state === "configured") {
      this.encoder.encode(frame, options);
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
      this.worker.terminate();
      this.worker = null;
    } else if (this.encoder) {
      this.encoder.close();
      this.encoder = null;
    }
    this.configured = false;
  }
}
