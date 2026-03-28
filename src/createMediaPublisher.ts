/**
 * 高レベル MediaPublisher API
 *
 * MediaStream を使用した簡単なメディア配信機能を提供する
 */

import { connect } from "./index";
import type { CertificateHash, ConnectCallbacks, Session } from "./session";
import type { Publisher } from "./publisher";
import * as LOC from "./loc";
import {
  CATALOG_TRACK_NAME,
  createCatalog,
  encodeCatalog,
  type Catalog,
  type CatalogTrack,
} from "./msf";
import { AudioEncoderWrapper } from "./codec/AudioEncoder";
import { VideoEncoderWrapper } from "./codec/VideoEncoder";
import {
  DEFAULT_AUDIO_CHANNELS,
  DEFAULT_AUDIO_SAMPLE_RATE,
  DEFAULT_VIDEO_FRAMERATE,
  getAudioEncoderConfig,
  getVideoEncoderConfig,
} from "./codec/config";
import type {
  AudioPublishOptions,
  AudioStats,
  MediaPublisher,
  MediaPublisherCallbacks,
  MediaPublisherOptions,
  MediaPublisherState,
  MediaStats,
  VideoPublishOptions,
  VideoStats,
} from "./codec/types";

// デフォルト設定
const DEFAULT_AUDIO_TRACK_NAME = "audio";
const DEFAULT_VIDEO_TRACK_NAME = "video";

// Publisher Priority (ドキュメントに記載)
const PRIORITY_AUDIO = 192;
const PRIORITY_VIDEO_KEY = 255;
const PRIORITY_VIDEO_DELTA = 128;

/**
 * MediaPublisher の実装クラス
 */
class MediaPublisherImpl implements MediaPublisher {
  private currentState: MediaPublisherState = "created";
  private readonly url: string;
  private readonly options: MediaPublisherOptions;
  private readonly callbacks: MediaPublisherCallbacks;

  // 接続関連
  private session: Session | null = null;
  private catalogPublisher: Publisher | null = null;
  private audioPublisher: Publisher | null = null;
  private videoPublisher: Publisher | null = null;

  // MediaStream 関連
  private mediaStream: MediaStream | null = null;
  private audioTrackProcessor: MediaStreamTrackProcessor<AudioData> | null = null;
  private videoTrackProcessor: MediaStreamTrackProcessor<VideoFrame> | null = null;
  private audioFrameReader: ReadableStreamDefaultReader<AudioData> | null = null;
  private videoFrameReader: ReadableStreamDefaultReader<VideoFrame> | null = null;

  // エンコーダー
  private audioEncoder: AudioEncoderWrapper | null = null;
  private videoEncoder: VideoEncoderWrapper | null = null;

  // 統計情報
  private audioStats: AudioStats = {
    framesSent: 0,
    bytesSent: 0,
    currentGroupId: 0,
  };
  private videoStats: VideoStats = {
    framesSent: 0,
    keyFramesSent: 0,
    bytesSent: 0,
    currentGroupId: 0,
  };

  // グループ/オブジェクト管理
  private audioGroupId = 0;
  private audioObjectId = 0;
  private videoGroupId = 0;
  private videoObjectId = 0;
  private audioFrameCount = 0;
  private videoFrameCount = 0;

  // キーフレーム間隔
  private keyframeInterval: number;

  // 処理ループの中断フラグ
  private processingActive = false;

  // 現在の Catalog
  private currentCatalog: Catalog | null = null;

  constructor(
    url: string,
    options: MediaPublisherOptions,
    callbacks: MediaPublisherCallbacks = {},
  ) {
    this.url = url;
    this.options = options;
    this.callbacks = callbacks;

    // キーフレーム間隔を計算
    const framerate = options.video?.framerate ?? DEFAULT_VIDEO_FRAMERATE;
    this.keyframeInterval = options.video?.keyframeInterval ?? framerate * 2;
  }

  get state(): MediaPublisherState {
    return this.currentState;
  }

  private setState(newState: MediaPublisherState): void {
    this.currentState = newState;
    this.callbacks.onStateChange?.(newState);
  }

  /**
   * 配信を開始する
   */
  async start(stream: MediaStream): Promise<void> {
    if (this.currentState !== "created" && this.currentState !== "stopped") {
      throw new Error(`cannot start in state: ${this.currentState}`);
    }

    this.mediaStream = stream;

    try {
      // サーバーに接続
      await this.connectToServer();

      // Publisher を作成
      await this.createPublishers();

      // エンコーダーを設定
      await this.setupEncoders();

      // 処理ループを開始
      this.processingActive = true;
      this.startProcessingLoops();

      this.setState("publishing");
    } catch (error) {
      this.callbacks.onError?.(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  /**
   * 配信を一時停止する
   */
  pause(): void {
    if (this.currentState !== "publishing") {
      throw new Error(`cannot pause in state: ${this.currentState}`);
    }

    this.processingActive = false;
    this.setState("paused");
  }

  /**
   * 配信を再開する
   */
  resume(): void {
    if (this.currentState !== "paused") {
      throw new Error(`cannot resume in state: ${this.currentState}`);
    }

    this.processingActive = true;
    this.startProcessingLoops();
    this.setState("publishing");
  }

  /**
   * 配信を停止する
   */
  async stop(): Promise<void> {
    if (this.currentState !== "publishing" && this.currentState !== "paused") {
      throw new Error(`cannot stop in state: ${this.currentState}`);
    }

    this.processingActive = false;

    // フレームリーダーをキャンセル
    await this.cancelFrameReaders();

    // Publisher を終了
    if (this.audioPublisher && this.audioPublisher.state === "active") {
      await this.audioPublisher.done();
    }
    if (this.videoPublisher && this.videoPublisher.state === "active") {
      await this.videoPublisher.done();
    }

    this.setState("stopped");
  }

  /**
   * キーフレームを即座に送信する
   */
  requestKeyframe(): void {
    if (this.currentState !== "publishing") {
      return;
    }

    // 次のフレームでキーフレームを強制する
    this.videoFrameCount = 0;
  }

  /**
   * リソースを解放する
   */
  async close(): Promise<void> {
    if (this.currentState === "closed") {
      return;
    }

    this.processingActive = false;

    // フレームリーダーをキャンセル
    await this.cancelFrameReaders();

    // エンコーダーを閉じる
    this.audioEncoder?.close();
    this.videoEncoder?.close();

    // セッションを閉じる
    if (this.session) {
      await this.session.close();
    }

    this.setState("closed");
    this.callbacks.onClose?.();
  }

  /**
   * 統計情報を取得する
   */
  getStats(): MediaStats {
    return {
      audio: this.options.audio ? { ...this.audioStats } : null,
      video: this.options.video ? { ...this.videoStats } : null,
    };
  }

  /**
   * 現在の Catalog を取得する
   */
  getCatalog(): Catalog | null {
    return this.currentCatalog;
  }

  // 内部メソッド

  private async connectToServer(): Promise<void> {
    const connectCallbacks: ConnectCallbacks = {
      close: (_closeInfo) => {
        if (this.currentState !== "closed") {
          this.setState("closed");
          this.callbacks.onClose?.();
        }
      },
      error: (error) => {
        this.callbacks.onError?.(error);
      },
    };

    const connectOptions: { serverCertificateHashes?: CertificateHash[] } = {};
    if (this.options.serverCertificateHashes && this.options.serverCertificateHashes.length > 0) {
      connectOptions.serverCertificateHashes = this.options.serverCertificateHashes.map((hash) => ({
        algorithm: "sha-256" as const,
        value: hash,
      }));
    }

    this.session = await connect(this.url, connectCallbacks, connectOptions);
  }

  private async createPublishers(): Promise<void> {
    if (!this.session) {
      throw new Error("session not connected");
    }

    const namespace = this.options.namespace;

    // Catalog Publisher
    // maxCacheDuration を指定してサーバーにキャッシュさせる
    this.catalogPublisher = await this.session.publish(
      namespace,
      CATALOG_TRACK_NAME,
      {
        error: (error) => this.callbacks.onError?.(error),
      },
      {
        maxCacheDuration: 3600000n,
      },
    );

    // Audio Publisher
    if (this.options.audio) {
      const trackName = this.options.audio.trackName ?? DEFAULT_AUDIO_TRACK_NAME;
      this.audioPublisher = await this.session.publish(namespace, trackName, {
        error: (error) => this.callbacks.onError?.(error),
      });
    }

    // Video Publisher
    if (this.options.video) {
      const trackName = this.options.video.trackName ?? DEFAULT_VIDEO_TRACK_NAME;
      this.videoPublisher = await this.session.publish(namespace, trackName, {
        error: (error) => this.callbacks.onError?.(error),
      });
    }

    // Catalog を publish
    await this.publishCatalog();
  }

  /**
   * Catalog を作成して publish する
   */
  private async publishCatalog(): Promise<void> {
    if (!this.catalogPublisher || this.catalogPublisher.state !== "active") {
      return;
    }

    const tracks = this.createCatalogTracks();
    const catalog = createCatalog(tracks, {
      generatedAt: Date.now(),
    });

    // 作成した Catalog を保存
    this.currentCatalog = catalog;

    const payload = encodeCatalog(catalog);

    this.catalogPublisher.sendObject({
      groupId: 0,
      objectId: 0,
      payload,
      priority: 255,
    });
  }

  /**
   * Catalog 用のトラック情報を生成する
   */
  private createCatalogTracks(): CatalogTrack[] {
    const tracks: CatalogTrack[] = [];

    // Audio トラック
    if (this.options.audio) {
      const audioOptions = this.options.audio;
      const sampleRate = audioOptions.sampleRate ?? DEFAULT_AUDIO_SAMPLE_RATE;
      const channels = audioOptions.channels ?? DEFAULT_AUDIO_CHANNELS;
      const audioConfig = getAudioEncoderConfig(
        audioOptions.codec,
        audioOptions.bitrate,
        sampleRate,
        channels,
      );

      tracks.push({
        name: audioOptions.trackName ?? DEFAULT_AUDIO_TRACK_NAME,
        packaging: "loc",
        isLive: true,
        role: "audio",
        codec: audioConfig.codec,
        bitrate: audioOptions.bitrate,
        samplerate: sampleRate,
        channelConfig: String(channels),
      });
    }

    // Video トラック
    if (this.options.video && this.mediaStream) {
      const videoOptions = this.options.video;
      const videoTrack = this.mediaStream.getVideoTracks()[0];
      const videoSettings = videoTrack?.getSettings();
      const width = videoOptions.width ?? videoSettings?.width ?? 640;
      const height = videoOptions.height ?? videoSettings?.height ?? 480;
      const framerate = videoOptions.framerate ?? DEFAULT_VIDEO_FRAMERATE;

      const videoConfig = getVideoEncoderConfig(
        videoOptions.codec,
        width,
        height,
        videoOptions.bitrate,
        framerate,
      );

      tracks.push({
        name: videoOptions.trackName ?? DEFAULT_VIDEO_TRACK_NAME,
        packaging: "loc",
        isLive: true,
        role: "video",
        codec: videoConfig.codec,
        bitrate: videoOptions.bitrate,
        width,
        height,
        framerate,
      });
    }

    return tracks;
  }

  private async setupEncoders(): Promise<void> {
    const useWorker = this.options.useWorker ?? true;

    // Audio Encoder
    if (this.options.audio && this.mediaStream) {
      const audioTrack = this.mediaStream.getAudioTracks()[0];
      if (audioTrack) {
        this.audioEncoder = new AudioEncoderWrapper(useWorker, {
          output: (chunk) => this.handleAudioEncodedChunk(chunk),
          error: (error) => this.callbacks.onError?.(error),
        });

        const audioOptions = this.options.audio;
        await this.audioEncoder.configure(
          audioOptions.codec,
          audioOptions.bitrate,
          audioOptions.sampleRate ?? DEFAULT_AUDIO_SAMPLE_RATE,
          audioOptions.channels ?? DEFAULT_AUDIO_CHANNELS,
        );

        this.audioTrackProcessor = new MediaStreamTrackProcessor({ track: audioTrack });
        this.audioFrameReader = this.audioTrackProcessor.readable.getReader();
      }
    }

    // Video Encoder
    if (this.options.video && this.mediaStream) {
      const videoTrack = this.mediaStream.getVideoTracks()[0];
      if (videoTrack) {
        const videoSettings = videoTrack.getSettings();
        const width = this.options.video.width ?? videoSettings.width ?? 640;
        const height = this.options.video.height ?? videoSettings.height ?? 480;
        const framerate = this.options.video.framerate ?? DEFAULT_VIDEO_FRAMERATE;

        this.videoEncoder = new VideoEncoderWrapper(useWorker, {
          output: (chunk) => this.handleVideoEncodedChunk(chunk),
          error: (error) => this.callbacks.onError?.(error),
        });

        await this.videoEncoder.configure(
          this.options.video.codec,
          width,
          height,
          this.options.video.bitrate,
          framerate,
        );

        this.videoTrackProcessor = new MediaStreamTrackProcessor({ track: videoTrack });
        this.videoFrameReader = this.videoTrackProcessor.readable.getReader();
      }
    }
  }

  private startProcessingLoops(): void {
    if (this.audioFrameReader && this.audioEncoder) {
      void this.processAudioFrames();
    }
    if (this.videoFrameReader && this.videoEncoder) {
      void this.processVideoFrames();
    }
  }

  private async processAudioFrames(): Promise<void> {
    const reader = this.audioFrameReader;
    const encoder = this.audioEncoder;
    if (!reader || !encoder) return;

    try {
      while (this.processingActive && encoder.state === "configured") {
        const { value: audioData, done } = await reader.read();
        if (done) break;

        encoder.encode(audioData);
        audioData.close();
      }
    } catch (error) {
      if (this.processingActive) {
        this.callbacks.onError?.(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  private async processVideoFrames(): Promise<void> {
    const reader = this.videoFrameReader;
    const encoder = this.videoEncoder;
    if (!reader || !encoder) return;

    try {
      while (this.processingActive && encoder.state === "configured") {
        const { value: frame, done } = await reader.read();
        if (done) break;

        // キーフレーム判定
        const isKeyFrame = this.videoFrameCount % this.keyframeInterval === 0;
        this.videoFrameCount++;

        if (encoder.encodeQueueSize <= 2) {
          encoder.encode(frame, { keyFrame: isKeyFrame });
        }
        frame.close();
      }
    } catch (error) {
      if (this.processingActive) {
        this.callbacks.onError?.(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  private handleAudioEncodedChunk(chunk: {
    data: Uint8Array;
    type: "key" | "delta";
    timestamp: number;
    duration: number | null;
  }): void {
    if (!this.audioPublisher || this.audioPublisher.state !== "active") return;

    // LOC Properties をエンコード
    const properties = LOC.encodeAudioProperties({
      timestamp: BigInt(chunk.timestamp),
    });

    // オーディオは一定間隔で新しいグループを開始（約1秒ごと）
    this.audioFrameCount++;
    if (this.audioFrameCount % 50 === 0) {
      this.audioGroupId++;
      this.audioObjectId = 0;
    }

    const payload = chunk.data;
    this.audioStats.framesSent++;
    this.audioStats.bytesSent += payload.length + properties.length;
    this.audioStats.currentGroupId = this.audioGroupId;

    this.audioPublisher.sendObject({
      groupId: this.audioGroupId,
      objectId: this.audioObjectId++,
      payload,
      properties,
      priority: PRIORITY_AUDIO,
    });
  }

  private handleVideoEncodedChunk(chunk: {
    data: Uint8Array;
    type: "key" | "delta";
    timestamp: number;
    duration: number | null;
    description?: Uint8Array;
  }): void {
    if (!this.videoPublisher || this.videoPublisher.state !== "active") return;

    // キーフレームで新しいグループを開始
    if (chunk.type === "key") {
      this.videoGroupId++;
      this.videoObjectId = 0;
      this.videoStats.keyFramesSent++;
    }

    // LOC Properties をエンコード
    const properties = LOC.encodeVideoProperties({
      timestamp: BigInt(chunk.timestamp),
      frameMarking: {
        isIndependent: chunk.type === "key",
        isDiscardable: chunk.type !== "key",
        isBaseLayerSync: chunk.type === "key",
        temporalLayerId: 0,
        spatialLayerId: 0,
      },
    });

    const payload = chunk.data;
    this.videoStats.framesSent++;
    this.videoStats.bytesSent += payload.length + properties.length;
    this.videoStats.currentGroupId = this.videoGroupId;

    this.videoPublisher.sendObject({
      groupId: this.videoGroupId,
      objectId: this.videoObjectId++,
      payload,
      properties,
      priority: chunk.type === "key" ? PRIORITY_VIDEO_KEY : PRIORITY_VIDEO_DELTA,
    });
  }

  private async cancelFrameReaders(): Promise<void> {
    if (this.audioFrameReader) {
      try {
        await this.audioFrameReader.cancel();
      } catch {
        // 無視
      }
      this.audioFrameReader = null;
    }
    if (this.videoFrameReader) {
      try {
        await this.videoFrameReader.cancel();
      } catch {
        // 無視
      }
      this.videoFrameReader = null;
    }
  }
}

/**
 * MediaPublisher を作成する
 *
 * @param url - MOQT サーバーの URL
 * @param options - 配信オプション
 * @param callbacks - コールバック
 * @returns MediaPublisher インスタンス
 */
export async function createMediaPublisher(
  url: string,
  options: MediaPublisherOptions,
  callbacks?: MediaPublisherCallbacks,
): Promise<MediaPublisher> {
  if (!options.audio && !options.video) {
    throw new Error("at least one of audio or video must be specified");
  }

  return new MediaPublisherImpl(url, options, callbacks);
}

// 型のエクスポート
export type {
  MediaPublisher,
  MediaPublisherOptions,
  MediaPublisherCallbacks,
  MediaPublisherState,
  MediaStats,
  AudioStats,
  VideoStats,
  AudioPublishOptions,
  VideoPublishOptions,
};
