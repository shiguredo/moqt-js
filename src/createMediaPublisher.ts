/**
 * 高レベル MediaPublisher API
 *
 * MediaStream を使用した簡単なメディア配信機能を提供する
 */

import { connect } from "./index";
import type { ConnectCallbacks, ConnectOptions, Session } from "./session";
import type { Publisher } from "./publisher";
import * as LOC from "./loc";
import {
  CATALOG_TRACK_NAME,
  createCatalog,
  createInitialGroupId,
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
import {
  createVideoFrameSource,
  isMediaStreamTrackProcessorAvailable,
  type VideoFrameSource,
} from "./frameSource";

// デフォルト設定
const DEFAULT_AUDIO_TRACK_NAME = "audio";
const DEFAULT_VIDEO_TRACK_NAME = "video";

// Publisher Priority (ドキュメントに記載)
const PRIORITY_AUDIO = 192;
const PRIORITY_VIDEO_KEY = 255;
const PRIORITY_VIDEO_DELTA = 128;

// 同一プロセス内で割り当てた初期 Group ID の最大値
// (draft-ietf-moq-msf-01 §6.1: 再起動時の開始 Group ID は
// 同一 track の過去の全 Group ID を上回らなければならない)
// 音声・映像の両 track で共有し、安全側 (大きめ) に倒す。
let lastAllocatedInitialGroupId = 0;

/**
 * 初期 Group ID を割り当てる (MSF 生成に単調ガードを付けた Publisher 側の割当て)
 *
 * draft-ietf-moq-msf-01 §6.1 に基づき `createInitialGroupId` (Unix epoch
 * ミリ秒起点) を使う。`Date.now()` は `MAX_SAFE_INTEGER` に収まるため
 * Publisher 側の `number` 型に変換する。同一プロセス内の前回値を
 * 下回らないよう前回 + 1 との最大値を取る。プロセス跨ぎは壁時計に委ねる。
 * `candidate` は有限数のみ受け付け、非有限値は拒否する。
 *
 * 単体テストから固定値で駆動するため export する
 * (パッケージ公開 API には含めない)。
 */
export function allocateInitialGroupId(candidate = Number(createInitialGroupId())): number {
  if (!Number.isFinite(candidate)) {
    throw new Error(`initial group id candidate must be finite, got ${candidate}`);
  }
  const next = Math.max(candidate, lastAllocatedInitialGroupId + 1);
  lastAllocatedInitialGroupId = next;
  return next;
}

/**
 * MediaPublisher の実装クラス
 *
 * 単体テストから処理ループを駆動するため export する
 * (パッケージ公開 API には含めない)。
 */
export class MediaPublisherImpl implements MediaPublisher {
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
  private videoFrameSource: VideoFrameSource | null = null;
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
  private audioGroupId: number;
  private audioObjectId = 0;
  private videoGroupId: number;
  private videoObjectId = 0;
  private audioFrameCount = 0;
  private videoFrameCount = 0;
  // 映像の初回オブジェクト送信済みか (初回は加算せず初期値を送る)
  private videoGroupStarted = false;

  // キーフレーム間隔
  private keyframeInterval: number;

  // 処理ループの中断フラグ
  private processingActive = false;

  // 処理ループの世代 (pause / stop / close で加算し、
  // 旧ループの encode と onError 通知を抑止する)
  private processingGeneration = 0;

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

    // draft-ietf-moq-msf-01 §6.1: 開始 Group ID は同一 track の
    // 過去の全 Group ID を上回る。新規インスタンスごとに割り当てる。
    // 同一インスタンスの stop → start は値を引き継ぐ。
    // 未使用 track 分は採番しない。
    this.audioGroupId = options.audio ? allocateInitialGroupId() : 0;
    this.videoGroupId = options.video ? allocateInitialGroupId() : 0;
    this.audioStats.currentGroupId = this.audioGroupId;
    this.videoStats.currentGroupId = this.videoGroupId;

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
      // 確保済みを逆順に巻き戻す。 state は変えず再 start 可能にする。
      // 巻き戻し自体の失敗で元の失敗を隠さないよう握り潰す。
      try {
        await this.disposeAllResources();
      } catch {
        // 元のエラーを優先する
      }
      this.callbacks.onError?.(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  /**
   * 配信を一時停止する
   *
   * 世代を進めて旧ループを無効化する。 reader の cancel は行わない。
   * cancel はストリームを閉じるため、 resume 時に処理を再開できなくなる
   * (再開にはプロセッサ再構築というブラウザ専用機構が必要になる)。
   * 同一 reader への並行 read() はフレームを排他的に分配するため、
   * 旧ループの encode と onError は世代不一致で抑止される。
   * ただし旧ループ自体の終了は次フレーム到着まで遅延し、その間に取得した
   * 1 フレームは破棄される。また pause 中にキュー滞留した 2 フレーム目以降は
   * resume 後に新ループが stale フレームとして encode する。
   * フレーム到着がない間の待機は残留し、stop / close の cancel で回収される。
   */
  pause(): void {
    if (this.currentState !== "publishing") {
      throw new Error(`cannot pause in state: ${this.currentState}`);
    }

    this.processingActive = false;
    this.processingGeneration++;
    this.setState("paused");
  }

  /**
   * 配信を再開する
   *
   * 現世代のまま処理ループを起動する。 paused からのみ到達する。
   * 旧ループは次フレーム到着時に世代不一致で encode せず終了し、
   * 失敗通知も抑止されるため、 encode と onError の多重化は起きない
   * (read() 待機自体の一時的な並行は残る)。
   * reader は pause で破棄していないため再取得は不要である。
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
   *
   * 再 start 可能な完全停止であり、確保済みを残さない。
   * session は閉じて再 start 時に再接続する (再利用しない)。
   * 破棄の段階失敗は後続を止めず、最後に最初の失敗を throw する。
   * 失敗時は旧 state のまま残るが参照は切り離し済みのため再試行できる。
   * 並行呼び出しは未対応であり直列に呼ぶこと。
   */
  async stop(): Promise<void> {
    if (this.currentState !== "publishing" && this.currentState !== "paused") {
      throw new Error(`cannot stop in state: ${this.currentState}`);
    }

    // 世代を進める。 stop 後の cancel 解決と start 後の新ループが
    // 同一世代を共有しないようにする (旧ループ失敗の誤通知防止)
    this.processingGeneration++;

    await this.disposeAllResources();

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
   *
   * stop と同一破棄を内包し、以後 start 不可の終端とする。
   * 破棄の段階失敗は後続を止めず、最後に最初の失敗を throw する。
   * 失敗時は旧 state のまま残るが参照は切り離し済みのため再試行できる。
   * 並行呼び出しは未対応であり直列に呼ぶこと。
   * (直列の二重 close は成功時に限り早期 return で単発性を保つ)。
   */
  async close(): Promise<void> {
    if (this.currentState === "closed") {
      return;
    }

    // 世代を進める。 close 後の cancel 解決と再 start 後の新ループが
    // 同一世代を共有しないようにする (旧ループ失敗の誤通知防止)
    this.processingGeneration++;

    await this.disposeAllResources();

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

    const connectOptions: ConnectOptions = {};
    if (this.options.serverCertificateHashes && this.options.serverCertificateHashes.length > 0) {
      connectOptions.serverCertificateHashes = this.options.serverCertificateHashes.map((hash) => ({
        algorithm: "sha-256" as const,
        value: hash,
      }));
    }
    if (this.options.authorizationToken) {
      connectOptions.authorizationToken = this.options.authorizationToken;
    }
    if (this.options.pendingSubgroup) {
      connectOptions.pendingSubgroup = this.options.pendingSubgroup;
    }

    this.session = await connect(this.url, connectCallbacks, connectOptions);
  }

  private async createPublishers(): Promise<void> {
    if (!this.session) {
      throw new Error("session not connected");
    }

    const namespace = this.options.namespace;

    // Catalog パブリッシャー
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

    // 音声パブリッシャー
    if (this.options.audio) {
      const trackName = this.options.audio.trackName ?? DEFAULT_AUDIO_TRACK_NAME;
      this.audioPublisher = await this.session.publish(namespace, trackName, {
        error: (error) => this.callbacks.onError?.(error),
      });
    }

    // 映像パブリッシャー
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
   *
   * draft-ietf-moq-msf-01 §5: All catalog updates, both independent and delta,
   * MUST be mapped to MOQT sub-group 0. The first Object (with Object ID 0) in
   * any Group in a catalog track MUST hold an independent copy of the catalog.
   *
   * draft-ietf-moq-msf-01 §11.2: An MSF publisher MUST publish a catalog track
   * object before publishing any media track objects.
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

    // Catalog object が WebTransport stream に書き込み完了するまで await する。
    // draft-ietf-moq-transport-20 §10.13: FETCH は object が publish されていなければ
    // INVALID_RANGE で REQUEST_ERROR を返す MUST。fire-and-forget だと publisher.start() の
    // return 後すぐに subscriber が join した場合に race を踏むため、catalog だけは確実に
    // 書き込み完了してから return する。
    // groupId=0, objectId=0 は draft-ietf-moq-msf-01 §5 で MUST 規定 (independent catalog
    // in subgroup 0)。
    await this.catalogPublisher.sendObject({
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

    // 音声エンコーダー
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

        if (!isMediaStreamTrackProcessorAvailable()) {
          throw new Error(
            "MediaStreamTrackProcessor is required for audio publishing but is not available in this browser",
          );
        }
        this.audioTrackProcessor = new MediaStreamTrackProcessor({ track: audioTrack });
        this.audioFrameReader = this.audioTrackProcessor.readable.getReader();
      }
    }

    // 映像エンコーダー
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

        this.videoFrameSource = createVideoFrameSource(videoTrack);
        this.videoFrameReader = this.videoFrameSource.readable.getReader();
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
    const generation = this.processingGeneration;

    try {
      while (
        this.processingActive &&
        generation === this.processingGeneration &&
        encoder.state === "configured"
      ) {
        const { value: audioData, done } = await reader.read();
        if (done) break;
        if (generation !== this.processingGeneration) {
          // 旧世代ループは encode せず終了する (フレームは破棄前に閉じる)
          audioData.close();
          break;
        }

        encoder.encode(audioData);
        audioData.close();
      }
    } catch (error) {
      // 旧世代ループの失敗は通知しない (多重発火の防止)
      if (this.processingActive && generation === this.processingGeneration) {
        this.callbacks.onError?.(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  private async processVideoFrames(): Promise<void> {
    const reader = this.videoFrameReader;
    const encoder = this.videoEncoder;
    if (!reader || !encoder) return;
    const generation = this.processingGeneration;

    try {
      while (
        this.processingActive &&
        generation === this.processingGeneration &&
        encoder.state === "configured"
      ) {
        const { value: frame, done } = await reader.read();
        if (done) break;
        if (generation !== this.processingGeneration) {
          // 旧世代ループは encode せず終了する (フレームは破棄前に閉じる)
          frame.close();
          break;
        }

        // キーフレーム判定
        const isKeyFrame = this.videoFrameCount % this.keyframeInterval === 0;
        this.videoFrameCount++;

        if (encoder.encodeQueueSize <= 2) {
          encoder.encode(frame, { keyFrame: isKeyFrame });
        }
        frame.close();
      }
    } catch (error) {
      // 旧世代ループの失敗は通知しない (多重発火の防止)
      if (this.processingActive && generation === this.processingGeneration) {
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

    // LOC Properties をエンコード。
    // TIMESTAMP は Unix epoch マイクロ秒 (壁時計) で送る
    // (draft-ietf-moq-loc-04 §2.3.1.1。TIMESCALE は付けない)。
    const properties = LOC.encodeAudioProperties({
      timestamp: LOC.toUnixEpochMicroseconds(BigInt(chunk.timestamp), performance.timeOrigin),
    });

    // オーディオは一定間隔で新しいグループを開始（約1秒ごと）
    this.audioFrameCount++;
    if (this.audioFrameCount % 50 === 0) {
      this.audioGroupId++;
      this.audioObjectId = 0;
      // draft-ietf-moq-msf-01 §6.1: 送信済み最大を追跡し、
      // 次インスタンスの開始 Group ID が上回るようにする
      lastAllocatedInitialGroupId = Math.max(lastAllocatedInitialGroupId, this.audioGroupId);
    }

    const payload = chunk.data;
    this.audioStats.framesSent++;
    this.audioStats.bytesSent += payload.length + properties.length;
    this.audioStats.currentGroupId = this.audioGroupId;

    // 音声フレームは fire-and-forget。落としても良いし、後続のオブジェクトで上書きされる
    void this.audioPublisher.sendObject({
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
    // (初回オブジェクトは加算せず初期値を送る。実運用経路は初回を
    // key で要求するため、delta 先行時は初回 key が初期値 + 1 になる)
    if (chunk.type === "key") {
      if (this.videoGroupStarted) {
        this.videoGroupId++;
        // draft-ietf-moq-msf-01 §6.1: 送信済み最大を追跡し、
        // 次インスタンスの開始 Group ID が上回るようにする
        lastAllocatedInitialGroupId = Math.max(lastAllocatedInitialGroupId, this.videoGroupId);
      }
      this.videoObjectId = 0;
      this.videoStats.keyFramesSent++;
    }

    // LOC Properties をエンコード。
    // TIMESTAMP は Unix epoch マイクロ秒 (壁時計) で送る
    // (draft-ietf-moq-loc-04 §2.3.1.1。TIMESCALE は付けない)。
    // isDiscardable は WebCodecs が破棄可能性情報を提供しないため false 固定 (RFC 9626 §3.1 D の
    // 「the sender knows」を守るため)。isBaseLayerSync はソース上のキーフレーム意図マーカとして
    // 残すが、temporalLayerId=0 固定のためワイヤ上 B=0 に抑圧される (詳細は
    // encodeVideoFrameMarking を参照)。
    const properties = LOC.encodeVideoProperties({
      timestamp: LOC.toUnixEpochMicroseconds(BigInt(chunk.timestamp), performance.timeOrigin),
      frameMarking: {
        isIndependent: chunk.type === "key",
        isDiscardable: false,
        isBaseLayerSync: chunk.type === "key",
        temporalLayerId: 0,
        spatialLayerId: 0,
      },
    });

    const payload = chunk.data;
    this.videoStats.framesSent++;
    this.videoStats.bytesSent += payload.length + properties.length;
    this.videoStats.currentGroupId = this.videoGroupId;

    // 映像フレームは fire-and-forget。落としても良いし、後続のオブジェクトで上書きされる
    void this.videoPublisher.sendObject({
      groupId: this.videoGroupId,
      objectId: this.videoObjectId++,
      payload,
      properties,
      priority: chunk.type === "key" ? PRIORITY_VIDEO_KEY : PRIORITY_VIDEO_DELTA,
    });
    this.videoGroupStarted = true;
  }

  /**
   * 確保済みリソースを逆順に巻き戻す
   *
   * stop / close / start 失敗時で共用する。取得の逆順
   * (reader → source・processor・encoder → Publisher → session) で
   * 破棄し参照を null 化する。reader の cancel は握り潰し内蔵のため
   * guard の外で先行する。それ以外の各段階は参照の切り離しを
   * await の前に行い、一段階の失敗が後続破棄を止めない。
   * 最初の失敗は最後に再 throw する。
   * 二重破棄は冪等操作のみで行う
   * (Publisher の active ガード付き done、encoder・source・session の
   * null 安全な close に依存する)。Catalog・統計・Group ID・
   * オブジェクト ID・フレーム数・映像開始済みフラグは
   * 再 start に引き継ぐため保持する。
   */
  private async disposeAllResources(): Promise<void> {
    this.processingActive = false;

    // フレームリーダーをキャンセル
    await this.cancelFrameReaders();

    // 段階破棄の失敗を集め、後続を止めず最後に最初の失敗を投げる
    let firstFailure: Error | null = null;
    const guard = async (task: () => Promise<void> | void): Promise<void> => {
      try {
        await task();
      } catch (error) {
        firstFailure ??= error instanceof Error ? error : new Error(String(error));
      }
    };

    // VideoFrameSource とプロセッサを解放する
    const videoFrameSource = this.videoFrameSource;
    this.videoFrameSource = null;
    await guard(() => videoFrameSource?.close());
    this.audioTrackProcessor = null;
    // 次回 start() で上書きされるため保持しない
    this.mediaStream = null;

    // エンコーダーを閉じる
    const audioEncoder = this.audioEncoder;
    this.audioEncoder = null;
    await guard(() => audioEncoder?.close());
    const videoEncoder = this.videoEncoder;
    this.videoEncoder = null;
    await guard(() => videoEncoder?.close());

    // Publisher を終了
    const catalogPublisher = this.catalogPublisher;
    this.catalogPublisher = null;
    await guard(async () => {
      if (catalogPublisher && catalogPublisher.state === "active") {
        await catalogPublisher.done();
      }
    });
    const audioPublisher = this.audioPublisher;
    this.audioPublisher = null;
    await guard(async () => {
      if (audioPublisher && audioPublisher.state === "active") {
        await audioPublisher.done();
      }
    });
    const videoPublisher = this.videoPublisher;
    this.videoPublisher = null;
    await guard(async () => {
      if (videoPublisher && videoPublisher.state === "active") {
        await videoPublisher.done();
      }
    });

    // セッションを閉じる
    const session = this.session;
    this.session = null;
    await guard(async () => {
      if (session) {
        await session.close();
      }
    });

    if (firstFailure !== null) {
      const failure: Error = firstFailure;
      throw failure;
    }
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
 * @param url - MOQT サーバーの URL (例: `moqt://example.com/moqt`)
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
