/**
 * オーディオデコーダーラッパー
 *
 * Worker モードと直接実行モードを抽象化する
 */

import type { AudioCodecType, AudioDecoderWrapperCallbacks } from "./types";
import { getAudioDecoderConfig } from "./config";
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
import type { AudioDecoderWorkerData } from "./workerMessages";

/**
 * オーディオデコーダーラッパークラス
 */
export class AudioDecoderWrapper {
  private useWorker: boolean;
  private decoder: AudioDecoder | null = null;
  private worker: Worker | null = null;
  private callbacks: AudioDecoderWrapperCallbacks;
  private configured = false;
  // configure() 発行ごとの世代管理 (並行 configure の所有権分離用)
  private readonly generationTracker = new ConfigureGenerationTracker();

  constructor(useWorker: boolean, callbacks: AudioDecoderWrapperCallbacks) {
    this.useWorker = useWorker;
    this.callbacks = callbacks;
  }

  /**
   * デコーダーを設定する
   *
   * @param description - AAC の AudioSpecificConfig (draft-ietf-moq-loc-04 §2.3.3.1)。
   *   opus では不要。
   */
  async configure(
    codec: AudioCodecType,
    sampleRate?: number,
    channels?: number,
    description?: Uint8Array,
  ): Promise<void> {
    const config = getAudioDecoderConfig(codec, sampleRate, channels, description);

    if (this.useWorker) {
      await this.configureWorker(config);
    } else {
      this.configureDirect(config);
    }
    this.configured = true;
  }

  private async configureWorker(config: AudioDecoderConfig): Promise<void> {
    await configureWrapperWorker({
      config,
      tracker: this.generationTracker,
      slot: wrapperWorkerSlot(
        () => this.worker,
        (worker) => {
          this.worker = worker;
        },
      ),
      dataTypes: ["decoded"],
      loadWorkerModule: () => import("./workers/audioDecoder.worker?worker"),
      // dataTypes で "decoded" のみを受け取るため、種別の分岐は不要
      handleWorkerData: (response) => {
        const message = response as AudioDecoderWorkerData;
        this.callbacks.output({
          data: message.data,
        });
      },
      notifyError: (error) => this.callbacks.error(error),
    });
  }

  private configureDirect(config: AudioDecoderConfig): void {
    this.decoder = replaceCodec(
      this.decoder,
      new AudioDecoder({
        output: (audioData: AudioData) => {
          this.callbacks.output({
            data: audioData,
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
   * エンコードされたオーディオチャンクをデコードする
   */
  decode(data: Uint8Array, type: "key" | "delta", timestamp: number, duration: number): void {
    if (!this.configured) {
      warnCodecNotConfigured("AudioDecoderWrapper");
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
