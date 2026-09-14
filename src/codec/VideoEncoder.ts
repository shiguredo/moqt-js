/**
 * ビデオエンコーダーラッパー
 *
 * Worker モードと直接実行モードを抽象化する
 */

import type { VideoCodecType, VideoEncoderWrapperCallbacks } from "./types";
import { getVideoEncoderConfig } from "./config";
import {
  ConfigureGenerationTracker,
  configureWrapperWorker,
  disposeWorker,
  wrapperWorkerSlot,
} from "./workerConfigure";
import {
  closeCodecQuiet,
  codecStateLabel,
  isCodecConfigured,
  replaceCodec,
  warnCodecNotConfigured,
} from "./codecLifecycle";
import type { VideoEncoderWorkerData } from "./workerMessages";

/**
 * ビデオエンコーダーラッパークラス
 */
export class VideoEncoderWrapper {
  private useWorker: boolean;
  private encoder: VideoEncoder | null = null;
  private worker: Worker | null = null;
  private callbacks: VideoEncoderWrapperCallbacks;
  private configured = false;
  // configure() 発行ごとの世代管理 (並行 configure の所有権分離用)
  private readonly generationTracker = new ConfigureGenerationTracker();

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
      this.configureDirect(config);
    }
    this.configured = true;
  }

  private async configureWorker(config: VideoEncoderConfig): Promise<void> {
    await configureWrapperWorker({
      config,
      tracker: this.generationTracker,
      slot: wrapperWorkerSlot(
        () => this.worker,
        (worker) => {
          this.worker = worker;
        },
      ),
      dataTypes: ["encoded"],
      loadWorkerModule: () => import("./workers/videoEncoder.worker?worker"),
      // dataTypes で "encoded" のみを受け取るため、種別の分岐は不要
      handleWorkerData: (response) => {
        const message = response as VideoEncoderWorkerData;
        // exactOptionalPropertyTypes では optional な description に undefined を渡せないため、
        // 値がある場合だけ載せる
        const description = message.description ? new Uint8Array(message.description) : undefined;
        this.callbacks.output({
          data: new Uint8Array(message.data),
          type: message.chunkType,
          timestamp: message.timestamp,
          duration: message.duration,
          ...(description !== undefined ? { description } : {}),
        });
      },
      notifyError: (error) => this.callbacks.error(error),
    });
  }

  private configureDirect(config: VideoEncoderConfig): void {
    this.encoder = replaceCodec(
      this.encoder,
      new VideoEncoder({
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

          // exactOptionalPropertyTypes では optional な description に undefined を渡せないため、
          // 値がある場合だけ載せる
          this.callbacks.output({
            data,
            type: chunk.type,
            timestamp: chunk.timestamp,
            duration: chunk.duration,
            ...(description !== undefined ? { description } : {}),
          });
        },
        error: (error: DOMException) => {
          this.callbacks.error(new Error(error.message));
        },
      }),
    );

    this.encoder.configure(config);
  }

  /**
   * ビデオフレームをエンコードする
   */
  encode(frame: VideoFrame, options?: VideoEncoderEncodeOptions): void {
    if (!this.configured) {
      warnCodecNotConfigured("VideoEncoderWrapper");
      return;
    }

    // 公開中の最新世代に送る (待機中の未公開世代には送らない)。
    // 再 configure() 待機中は旧公開が受け、公開切り替え後に新世代へ切り替わる。
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
    } else if (isCodecConfigured(this.encoder)) {
      this.encoder.encode(frame, options);
    }
  }

  /**
   * エンコーダーの状態を取得する
   */
  get state(): string {
    return codecStateLabel(this.useWorker, this.configured, this.encoder);
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
      closeCodecQuiet(this.encoder);
      this.encoder = null;
    }
    this.configured = false;
  }
}
