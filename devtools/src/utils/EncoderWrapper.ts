// EncoderWrapper: Worker と直接実行を抽象化するラッパー

import EncoderWorker from "../webcodecs-devtools/workers/encoder.worker?worker";

export interface EncodedChunkData {
  data: Uint8Array;
  type: "key" | "delta";
  timestamp: number;
  duration: number | null;
  description?: Uint8Array;
}

export interface EncoderWrapperCallbacks {
  output: (chunk: EncodedChunkData) => void;
  error: (error: Error) => void;
}

export class EncoderWrapper {
  private useWorker: boolean;
  private encoder: VideoEncoder | null = null;
  private worker: Worker | null = null;
  private callbacks: EncoderWrapperCallbacks;
  private configured = false;

  constructor(useWorker: boolean, callbacks: EncoderWrapperCallbacks) {
    this.useWorker = useWorker;
    this.callbacks = callbacks;
  }

  async configure(config: VideoEncoderConfig): Promise<void> {
    if (this.useWorker) {
      await this.configureWorker(config);
    } else {
      await this.configureDirect(config);
    }
    this.configured = true;
  }

  private async configureWorker(config: VideoEncoderConfig): Promise<void> {
    this.worker = new EncoderWorker();

    return new Promise((resolve, reject) => {
      if (!this.worker) {
        reject(new Error("Worker not initialized"));
        return;
      }

      this.worker.onmessage = (e: MessageEvent) => {
        const message = e.data;

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

      this.worker.onerror = (e) => {
        this.callbacks.error(new Error(e.message));
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

  encode(frame: VideoFrame, options?: VideoEncoderEncodeOptions): void {
    if (!this.configured) {
      console.warn("EncoderWrapper: not configured");
      return;
    }

    if (this.useWorker && this.worker) {
      // Worker モードでは frame を transfer する
      // transfer 後は呼び出し元で frame.close() を呼んでも安全（no-op）
      this.worker.postMessage(
        {
          type: "encode",
          frame,
          keyFrame: options?.keyFrame ?? false,
        },
        [frame],
      );
    } else if (this.encoder && this.encoder.state === "configured") {
      // 直接モードではエンコードのみ実行
      // frame.close() は呼び出し元が責任を持つ
      this.encoder.encode(frame, options);
    }
  }

  get state(): string {
    if (this.useWorker) {
      return this.configured ? "configured" : "unconfigured";
    }
    return this.encoder?.state ?? "unconfigured";
  }

  get encodeQueueSize(): number {
    if (this.useWorker) {
      // Worker モードでは直接 encodeQueueSize を取得できないため 0 を返す
      // Worker 内部でキュー管理される
      return 0;
    }
    return this.encoder?.encodeQueueSize ?? 0;
  }

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
