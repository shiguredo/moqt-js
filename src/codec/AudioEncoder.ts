/**
 * オーディオエンコーダーラッパー
 *
 * Worker モードと直接実行モードを抽象化する
 */

import type { AudioCodecType, AudioEncoderWrapperCallbacks } from "./types";
import { getAudioEncoderConfig } from "./config";
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
import type { AudioEncoderWorkerData } from "./workerMessages";

/**
 * オーディオエンコーダーラッパークラス
 */
export class AudioEncoderWrapper {
  private useWorker: boolean;
  private encoder: AudioEncoder | null = null;
  private worker: Worker | null = null;
  private callbacks: AudioEncoderWrapperCallbacks;
  private configured = false;
  // configure() 発行ごとの世代管理 (並行 configure の所有権分離用)
  private readonly generationTracker = new ConfigureGenerationTracker();

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
      this.configureDirect(config);
    }
    this.configured = true;
  }

  private async configureWorker(config: AudioEncoderConfig): Promise<void> {
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
      loadWorkerModule: () => import("./workers/audioEncoder.worker?worker"),
      // dataTypes で "encoded" のみを受け取るため、種別の分岐は不要
      handleWorkerData: (response) => {
        const message = response as AudioEncoderWorkerData;
        this.callbacks.output({
          data: new Uint8Array(message.data),
          type: message.chunkType,
          timestamp: message.timestamp,
          duration: message.duration,
        });
      },
      notifyError: (error) => this.callbacks.error(error),
    });
  }

  private configureDirect(config: AudioEncoderConfig): void {
    this.encoder = replaceCodec(
      this.encoder,
      new AudioEncoder({
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
      }),
    );

    this.encoder.configure(config);
  }

  /**
   * オーディオデータをエンコードする
   */
  encode(audioData: AudioData): void {
    if (!this.configured) {
      warnCodecNotConfigured("AudioEncoderWrapper");
      return;
    }

    // 公開中の最新世代に送る (待機中の未公開世代には送らない)。
    // 再 configure() 待機中は旧公開が受け、公開切り替え後に新世代へ切り替わる。
    if (this.useWorker && this.worker) {
      // Worker モードでは audioData を transfer する
      this.worker.postMessage(
        {
          type: "encode",
          data: audioData,
        },
        [audioData],
      );
    } else if (isCodecConfigured(this.encoder)) {
      this.encoder.encode(audioData);
    }
  }

  /**
   * エンコーダーの状態を取得する
   */
  get state(): string {
    return codecStateLabel(this.useWorker, this.configured, this.encoder);
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
