// DecoderWrapper: Worker と直接実行を抽象化するラッパー

import DecoderWorker from "../webcodecs-devtools/workers/decoder.worker?worker";

export interface DecodedFrameData {
  frame: VideoFrame;
}

export interface DecoderWrapperCallbacks {
  output: (data: DecodedFrameData) => void;
  error: (error: Error) => void;
}

export class DecoderWrapper {
  private useWorker: boolean;
  private decoder: VideoDecoder | null = null;
  private worker: Worker | null = null;
  private callbacks: DecoderWrapperCallbacks;
  private configured = false;
  // 直接モード用: キーフレーム待ちフラグ
  private needsKeyframe = true;
  // 最後に使用した設定（リセット用）
  private lastConfig: VideoDecoderConfig | null = null;

  constructor(useWorker: boolean, callbacks: DecoderWrapperCallbacks) {
    this.useWorker = useWorker;
    this.callbacks = callbacks;
  }

  async configure(config: VideoDecoderConfig): Promise<void> {
    this.lastConfig = config;
    if (this.useWorker) {
      await this.configureWorker(config);
    } else {
      await this.configureDirect(config);
    }
    this.configured = true;
  }

  private async configureWorker(config: VideoDecoderConfig): Promise<void> {
    this.worker = new DecoderWorker();

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
          case "decoded":
            this.callbacks.output({
              frame: message.frame,
            });
            break;
          case "skipped":
            // キーフレーム待ちでスキップされたフレームは無視
            // 必要に応じてコールバックを追加可能
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

  decode(chunk: EncodedVideoChunk): void {
    if (!this.configured) {
      console.warn("DecoderWrapper: not configured");
      return;
    }

    if (this.useWorker && this.worker) {
      // Worker にデータを転送
      // キーフレーム待ちの処理は Worker 側で行う
      const data = new ArrayBuffer(chunk.byteLength);
      chunk.copyTo(data);

      this.worker.postMessage(
        {
          type: "decode",
          data,
          chunkType: chunk.type,
          timestamp: chunk.timestamp,
          duration: chunk.duration ?? 0,
        },
        [data],
      );
    } else if (this.decoder && this.decoder.state === "configured") {
      // 直接モード: キーフレーム待ちの処理
      if (this.needsKeyframe && chunk.type !== "key") {
        // キーフレームが必要な状態でデルタフレームを受信した場合はスキップ
        return;
      }

      // キーフレームを受信したらフラグをリセット
      if (chunk.type === "key") {
        this.needsKeyframe = false;
      }

      this.decoder.decode(chunk);
    }
  }

  get state(): string {
    if (this.useWorker) {
      return this.configured ? "configured" : "unconfigured";
    }
    return this.decoder?.state ?? "unconfigured";
  }

  // キーフレーム待ち状態にリセット
  resetKeyframeWait(): void {
    if (this.useWorker && this.worker) {
      this.worker.postMessage({ type: "resetKeyframeWait" });
    } else {
      this.needsKeyframe = true;
    }
  }

  // エラー後にデコーダーをリセット（再初期化して次のキーフレームを待つ）
  async reset(): Promise<void> {
    if (!this.lastConfig) {
      console.warn("DecoderWrapper: cannot reset without config");
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
    await this.configure(this.lastConfig);
  }

  close(): void {
    if (this.useWorker && this.worker) {
      this.worker.postMessage({ type: "close" });
      this.worker.terminate();
      this.worker = null;
    } else if (this.decoder) {
      // エラー状態では既に closed になっているのでチェック
      if (this.decoder.state !== "closed") {
        this.decoder.close();
      }
      this.decoder = null;
    }
    this.configured = false;
  }
}
