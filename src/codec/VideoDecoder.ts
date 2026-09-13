/**
 * ビデオデコーダーラッパー
 *
 * Worker モードと直接実行モードを抽象化する
 */

import type { VideoCodecType, VideoDecoderWrapperCallbacks } from "./types";
import { getVideoDecoderConfig } from "./config";
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
import { ignoreUnknownWorkerResponse, type VideoDecoderWorkerData } from "./workerMessages";

/**
 * ビデオデコーダーラッパークラス
 */
export class VideoDecoderWrapper {
  private useWorker: boolean;
  private decoder: VideoDecoder | null = null;
  private worker: Worker | null = null;
  private callbacks: VideoDecoderWrapperCallbacks;
  private configured = false;
  // configure() 発行ごとの世代管理 (並行 configure の所有権分離用)
  private readonly generationTracker = new ConfigureGenerationTracker();
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
      this.configureDirect(config);
    }
    this.configured = true;
  }

  private async configureWorker(config: VideoDecoderConfig): Promise<void> {
    await configureWrapperWorker({
      config,
      tracker: this.generationTracker,
      slot: wrapperWorkerSlot(
        () => this.worker,
        (worker) => {
          this.worker = worker;
        },
      ),
      dataTypes: ["decoded", "skipped"],
      loadWorkerModule: () => import("./workers/videoDecoder.worker?worker"),
      handleWorkerData: (response) => {
        const message = response as VideoDecoderWorkerData;
        switch (message.type) {
          case "decoded":
            this.callbacks.output({
              frame: message.frame,
            });
            break;
          case "skipped":
            // キーフレーム待ちでスキップされたフレームは無視
            break;
          default:
            ignoreUnknownWorkerResponse(message);
        }
      },
      notifyError: (error) => this.callbacks.error(error),
    });
  }

  private configureDirect(config: VideoDecoderConfig): void {
    // 新しいデコーダーはキーフレームを必要とする
    this.needsKeyframe = true;

    this.decoder = replaceCodec(
      this.decoder,
      new VideoDecoder({
        output: (frame: VideoFrame) => {
          this.callbacks.output({
            frame,
          });
        },
        error: (error: DOMException) => {
          this.callbacks.error(new Error(error.message));
        },
      }),
    );

    this.decoder.configure(config);
  }

  /**
   * デコーダーの状態を取得する
   */
  get state(): string {
    return codecStateLabel(this.useWorker, this.configured, this.decoder);
  }

  /**
   * エンコードされたビデオチャンクをデコードする
   */
  decode(data: Uint8Array, type: "key" | "delta", timestamp: number, duration: number): void {
    if (!this.configured) {
      warnCodecNotConfigured("VideoDecoderWrapper");
      return;
    }

    // 公開中の最新世代に送る (待機中の未公開世代には送らない)。
    // 再 configure() 待機中は旧公開が受け、公開切り替え後に新世代へ切り替わる。
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
    } else if (isCodecConfigured(this.decoder)) {
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

    // 待機中の configure 世代を無効化する (close と同一の中断扱い)。
    // 以降の begin() まで await を挟まず同期的連続とし、他 configure() の
    // begin() が割り込めないようにする。
    this.generationTracker.invalidateAll();

    // 現在のデコーダーをクリーンアップ
    if (this.useWorker && this.worker) {
      this.worker.postMessage({ type: "close" });
      const closing = this.worker;
      this.worker = null;
      disposeWorker(closing);
    } else if (this.decoder) {
      closeCodecQuiet(this.decoder);
      this.decoder = null;
    }

    this.configured = false;

    // 再初期化
    if (this.useWorker) {
      await this.configureWorker(this.lastConfig);
    } else {
      this.configureDirect(this.lastConfig);
    }
    this.configured = true;
  }

  /**
   * デコーダーを閉じる
   */
  close(): void {
    // 待機中の configure 世代を無効化する。
    // 遅延成功した旧世代は破棄・reject される (中断扱い)。
    this.generationTracker.invalidateAll();
    if (this.useWorker && this.worker) {
      const closing = this.worker;
      this.worker = null;
      disposeWorker(closing);
    } else if (this.decoder) {
      closeCodecQuiet(this.decoder);
      this.decoder = null;
    }
    this.configured = false;
  }
}
