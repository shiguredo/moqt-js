/**
 * オーディオエンコーダーラッパー
 *
 * Worker モードと直接実行モードを抽象化する
 */

import type { AudioCodecType, AudioEncoderWrapperCallbacks } from "./types";
import { getAudioEncoderConfig, requiresAudioSpecificConfig } from "./config";
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
import type {
  AudioEncoderWorkerEncodedResponse,
  AudioEncoderWorkerFlushRequest,
} from "./workerMessages";

/**
 * オーディオエンコーダーラッパークラス
 */
export class AudioEncoderWrapper {
  private useWorker: boolean;
  private encoder: AudioEncoder | null = null;
  private worker: Worker | null = null;
  private callbacks: AudioEncoderWrapperCallbacks;
  private configured = false;
  // configure() で指定されたコーデック (description を運ぶかの判断に使う)
  private codec: AudioCodecType | null = null;
  // configure() 発行ごとの世代管理 (並行 configure の所有権分離用)
  private readonly generationTracker = new ConfigureGenerationTracker();
  // 進行中の flush (worker モードで flush 要求の応答を待つ)。二重呼び出しは同じ Promise を共有する
  private pendingFlush: Promise<void> | null = null;
  private pendingFlushResolve: (() => void) | null = null;
  private pendingFlushReject: ((error: Error) => void) | null = null;

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
    this.codec = codec;
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
      dataTypes: ["encoded", "flushed"],
      loadWorkerModule: () => import("./workers/audioEncoder.worker?worker"),
      handleWorkerData: (response) => {
        // flush の完了応答。worker は flush の出力 (encoded) を送ってから flushed を
        // 送るため、これを受け取った時点で出力はすべて本体のコールバックへ届いている
        if (response.type === "flushed") {
          this.pendingFlushResolve?.();
          return;
        }
        const message = response as AudioEncoderWorkerEncodedResponse;
        // Worker は metadata をそのまま返すため、運ぶかの判断は Wrapper 側で行う。
        // exactOptionalPropertyTypes では optional な description に undefined を渡せないため、
        // 値がある場合だけ載せる
        const description =
          this.codec !== null && requiresAudioSpecificConfig(this.codec) && message.description
            ? new Uint8Array(message.description)
            : undefined;
        this.callbacks.output({
          data: new Uint8Array(message.data),
          type: message.chunkType,
          timestamp: message.timestamp,
          duration: message.duration,
          ...(description !== undefined ? { description } : {}),
        });
      },
      notifyError: (error) => {
        // flush の待ちを reject する (応答が来ないと停止がハングするため)
        this.pendingFlushReject?.(error);
        this.callbacks.error(error);
      },
    });
  }

  private configureDirect(config: AudioEncoderConfig): void {
    this.encoder = replaceCodec(
      this.encoder,
      new AudioEncoder({
        output: (chunk: EncodedAudioChunk, metadata?: EncodedAudioChunkMetadata) => {
          const data = new Uint8Array(chunk.byteLength);
          chunk.copyTo(data);

          // draft-ietf-moq-loc-04 §2.3.3.1 (Audio Config):
          // AAC は decoderConfig.description (AudioSpecificConfig) を必要とする。
          // 映像と同じく、metadata に現れたときだけ運ぶ。opus では運ばない
          // (既存の復号 timestamp 挙動を変えないため)。
          let description: Uint8Array | undefined;
          if (
            this.codec !== null &&
            requiresAudioSpecificConfig(this.codec) &&
            metadata?.decoderConfig?.description
          ) {
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
   * 符号化中の入力をすべて出力させ、出力のコールバックが終わるまで待つ
   *
   * 停止時に encoder の中に残った 1 パケットを取り出し、末尾を欠けさせないために使う。
   * 直接実行モードは WebCodecs の `AudioEncoder.flush()` を待つ (resolve した時点で
   * 出力はすべてコールバックへ渡っている)。Worker モードは worker へ `flush` を要求し、
   * worker が flush の出力を postMessage してから `flushed` を返す順序を待つ
   * (postMessage の順序が保たれるため、`flushed` の時点で出力は本体へ届いている)。
   * 未設定・未構成のときは何もしない。
   *
   * 二重に呼ばれた場合は進行中の Promise を返す。close() されると reject する。
   */
  async flush(): Promise<void> {
    if (!this.configured) {
      return;
    }
    if (this.useWorker) {
      const worker = this.worker;
      if (!worker) {
        return;
      }
      if (this.pendingFlush !== null) {
        return this.pendingFlush;
      }
      const flush = new Promise<void>((resolve, reject) => {
        this.pendingFlushResolve = resolve;
        this.pendingFlushReject = reject;
        const request: AudioEncoderWorkerFlushRequest = { type: "flush" };
        worker.postMessage(request);
      });
      this.pendingFlush = flush;
      try {
        await flush;
      } finally {
        this.pendingFlush = null;
        this.pendingFlushResolve = null;
        this.pendingFlushReject = null;
      }
      return;
    }
    if (this.encoder !== null && isCodecConfigured(this.encoder)) {
      await this.encoder.flush();
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
    // flush の待ちが残っていれば reject する (応答が来ないまま停止がハングしないように)
    this.pendingFlushReject?.(new Error("audio encoder closed before flush completed"));
    this.pendingFlush = null;
    this.pendingFlushResolve = null;
    this.pendingFlushReject = null;
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
