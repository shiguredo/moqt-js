/**
 * ビデオエンコーダーラッパー
 *
 * Worker モードと直接実行モードを抽象化する
 */

import type { VideoCodecType, VideoEncoderWrapperCallbacks } from "./types";
import { getVideoEncoderConfig } from "./config";
import { WorkerConfigureGate, disposeFailedWorker, toFailureMessage } from "./workerConfigure";

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

      // 初期化完了前の "error" は configure() の reject とし、
      // 完了後の "error" は従来どおり通知する (二重解決ガード付き)
      const gate = new WorkerConfigureGate();
      const failConfigure = (error: Error) => {
        if (gate.trySettle()) {
          const failed = this.worker;
          this.worker = null;
          disposeFailedWorker(failed);
          reject(error);
        } else {
          this.callbacks.error(error);
        }
      };

      this.worker.onmessage = (event: MessageEvent) => {
        const message = event.data;

        switch (message.type) {
          case "configured":
            if (gate.trySettle()) {
              resolve();
            }
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
            failConfigure(new Error(toFailureMessage(message.message)));
            break;
        }
      };

      this.worker.onerror = (event) => {
        failConfigure(new Error(toFailureMessage(event.message)));
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
