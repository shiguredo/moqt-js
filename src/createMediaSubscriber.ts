/**
 * 高レベル MediaSubscriber API
 *
 * MediaStream を使用した簡単なメディア受信機能を提供する
 */

import { connect } from "./index";
import { supportsDynamicGroups } from "./properties";
import type {
  ConnectCallbacks,
  ConnectOptions,
  Session,
  JoiningFetchOptions,
  SubscribeOptions,
} from "./session";
import type { Subscriber } from "./subscriber";
import type { MoqtObject } from "./dataStream";
import type { AuthorizationToken } from "./message";
import * as LOC from "./loc";
import {
  CATALOG_TRACK_NAME,
  applyCatalogDelta,
  decodeCatalogMessage,
  getAudioTracks,
  getVideoTracks,
  type AuthInfo,
  type Catalog,
  type CatalogTrack,
} from "./msf";
import { AudioDecoderWrapper } from "./codec/AudioDecoder";
import { VideoDecoderWrapper } from "./codec/VideoDecoder";
import { DEFAULT_AUDIO_CHANNELS, DEFAULT_AUDIO_SAMPLE_RATE } from "./codec/config";
import type {
  AudioCodecType,
  AudioReceiverStats,
  AudioSubscribeOptions,
  MediaReceiverStats,
  MediaSubscriber,
  MediaSubscriberCallbacks,
  MediaSubscriberOptions,
  MediaSubscriberState,
  VideoCodecType,
  VideoReceiverStats,
  VideoSubscribeOptions,
} from "./codec/types";

/**
 * authInfo に応じて Authorization Token を解決する純粋関数
 *
 * draft-ietf-moq-msf-01 §5.2.42: authInfo の存在は subscribe 時に認可トークンが必要であるシグナル。
 * §11.4.2: トークン取得は仕様の対象外のため、getAuthorizationToken コールバックで注入する。
 * §11.4.4: トークンを取得できない場合はエラーを呼び出し元に伝播する。
 *
 * @param authInfo track の authInfo（§5.2.42）。空または未指定なら認可不要。
 * @param getAuthorizationToken トークン取得コールバック（§11.4.2、呼び出し側注入）
 * @returns 解決したトークン。認可不要なら undefined。
 * @throws authInfo があるのにコールバック未提供、またはトークンを取得できない場合
 */
export async function resolveAuthorizationToken(
  authInfo: AuthInfo | undefined,
  getAuthorizationToken?: (
    authInfo: AuthInfo,
  ) => AuthorizationToken | undefined | Promise<AuthorizationToken | undefined>,
): Promise<AuthorizationToken | undefined> {
  if (!authInfo || Object.keys(authInfo).length === 0) {
    // 認可不要
    return undefined;
  }
  if (!getAuthorizationToken) {
    throw new Error(
      "track requires authorization (authInfo present) but no getAuthorizationToken callback was provided",
    );
  }
  const token = await getAuthorizationToken(authInfo);
  if (!token) {
    throw new Error("track requires authorization but getAuthorizationToken returned no token");
  }
  return token;
}

// デフォルト設定
const DEFAULT_AUDIO_TRACK_NAME = "audio";
const DEFAULT_VIDEO_TRACK_NAME = "video";
const CATALOG_RECEIVE_TIMEOUT = 5000;

/**
 * Catalog Object payload を現在カタログへ適用した結果
 *
 * - `full`: 独立フルカタログで置換
 * - `delta`: `applyCatalogDelta` 成功
 * - `ignored`: フル未受信時の delta（サイレント無視）
 * - `error`: decode / apply 失敗（`catalog` は入力 `current` を維持）
 */
export type ProcessCatalogPayloadResult =
  | { kind: "full"; catalog: Catalog }
  | { kind: "delta"; catalog: Catalog }
  | { kind: "ignored"; catalog: Catalog | null }
  | { kind: "error"; catalog: Catalog | null; error: Error };

/**
 * Catalog Object の payload を純関数で適用する
 *
 * `handleCatalogObject` から切り出した配線用ヘルパー。
 * CatalogDelta の判別は `"deltaUpdate" in message` とする（decode 後の内部マーカーは
 * 常に `deltaUpdate: true`。wire の boolean 形式ではない。draft-ietf-moq-msf-01 §5.1.6）。
 * delta 適用規則（§5.3）は `applyCatalogDelta` に委譲する。
 */
export function processCatalogPayload(
  current: Catalog | null,
  payload: Uint8Array,
): ProcessCatalogPayloadResult {
  try {
    const message = decodeCatalogMessage(payload);
    if ("deltaUpdate" in message) {
      if (current === null) {
        return { kind: "ignored", catalog: null };
      }
      const catalog = applyCatalogDelta(current, message);
      return { kind: "delta", catalog };
    }
    return { kind: "full", catalog: message };
  } catch (cause) {
    return {
      kind: "error",
      catalog: current,
      error: cause instanceof Error ? cause : new Error(String(cause)),
    };
  }
}

/**
 * WebCodecs 形式の codec 文字列から AudioCodecType に変換する
 */
function parseAudioCodec(codec: string): AudioCodecType {
  if (codec.startsWith("opus")) {
    return "opus";
  }
  if (codec.startsWith("mp4a")) {
    return "aac";
  }
  throw new Error(`unsupported audio codec: ${codec}`);
}

/**
 * WebCodecs 形式の codec 文字列から VideoCodecType に変換する
 */
function parseVideoCodec(codec: string): VideoCodecType {
  if (codec.startsWith("vp8")) {
    return "vp8";
  }
  if (codec.startsWith("vp09") || codec.startsWith("vp9")) {
    return "vp9";
  }
  if (codec.startsWith("avc1") || codec.startsWith("avc3")) {
    return "h264";
  }
  if (codec.startsWith("hvc1") || codec.startsWith("hev1")) {
    return "h265";
  }
  if (codec.startsWith("av01")) {
    return "av1";
  }
  throw new Error(`unsupported video codec: ${codec}`);
}

/**
 * MediaSubscriber の実装クラス
 */
class MediaSubscriberImpl implements MediaSubscriber {
  private currentState: MediaSubscriberState = "created";
  private readonly url: string;
  private readonly options: MediaSubscriberOptions;
  private readonly callbacks: MediaSubscriberCallbacks;

  // 接続関連
  private session: Session | null = null;
  private catalogSubscriber: Subscriber | null = null;
  private audioSubscriber: Subscriber | null = null;
  private videoSubscriber: Subscriber | null = null;

  // Catalog
  private receivedCatalog: Catalog | null = null;
  private catalogResolve: ((catalog: Catalog) => void) | null = null;
  // Catalog Joining FETCH フェーズ中フラグと live SUBSCRIBE バッファ
  // (映像の videoFetchInProgress / pendingVideoObjects に相当)
  private catalogFetchInProgress = false;
  private pendingCatalogObjects: MoqtObject[] = [];

  // Catalog から取得したトラック情報
  private audioTrackInfo: CatalogTrack | null = null;
  private videoTrackInfo: CatalogTrack | null = null;

  // MediaStream 関連
  private outputStream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private audioDestination: MediaStreamAudioDestinationNode | null = null;

  // ビデオ出力用
  private videoTrackGenerator: MediaStreamTrackGenerator<VideoFrame> | null = null;
  private videoWriter: WritableStreamDefaultWriter<VideoFrame> | null = null;

  // デコーダー
  private audioDecoder: AudioDecoderWrapper | null = null;
  private videoDecoder: VideoDecoderWrapper | null = null;

  // デコーダー設定状態
  private audioDecoderConfigured = false;
  private videoDecoderConfigured = false;

  // 統計情報
  private audioStats: AudioReceiverStats = {
    framesReceived: 0,
    bytesReceived: 0,
  };
  private videoStats: VideoReceiverStats = {
    framesReceived: 0,
    keyFramesReceived: 0,
    bytesReceived: 0,
  };

  // Joining Fetch 関連
  // FETCH 完了まで SUBSCRIBE オブジェクトをバッファリング
  private videoFetchInProgress = false;
  private pendingVideoObjects: MoqtObject[] = [];

  constructor(
    url: string,
    options: MediaSubscriberOptions,
    callbacks: MediaSubscriberCallbacks = {},
  ) {
    this.url = url;
    this.options = options;
    this.callbacks = callbacks;
  }

  get state(): MediaSubscriberState {
    return this.currentState;
  }

  get mediaStream(): MediaStream | null {
    return this.outputStream;
  }

  get catalog(): Catalog | null {
    return this.receivedCatalog;
  }

  private setState(newState: MediaSubscriberState): void {
    this.currentState = newState;
    this.callbacks.onStateChange?.(newState);
  }

  /**
   * 購読を開始する
   */
  async start(): Promise<void> {
    if (this.currentState !== "created") {
      throw new Error(`cannot start in state: ${this.currentState}`);
    }

    this.setState("subscribing");

    try {
      // サーバーに接続
      await this.connectToServer();

      // Catalog を subscribe して受信を待つ
      await this.subscribeCatalog();

      // Catalog からトラック情報を取得
      this.extractTrackInfo();

      // 出力 MediaStream を作成
      this.createOutputStream();

      // デコーダーを設定
      await this.setupDecoders();

      // メディアトラックを subscribe
      await this.subscribeMediaTracks();

      this.setState("active");
    } catch (error) {
      this.callbacks.onError?.(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  /**
   * 購読を停止する
   */
  async stop(): Promise<void> {
    if (this.currentState !== "active") {
      throw new Error(`cannot stop in state: ${this.currentState}`);
    }

    // Subscriber を終了
    if (this.catalogSubscriber && this.catalogSubscriber.state === "active") {
      await this.catalogSubscriber.unsubscribe();
    }
    if (this.audioSubscriber && this.audioSubscriber.state === "active") {
      await this.audioSubscriber.unsubscribe();
    }
    if (this.videoSubscriber && this.videoSubscriber.state === "active") {
      await this.videoSubscriber.unsubscribe();
    }

    this.setState("stopped");
  }

  /**
   * キーフレームを要求する
   */
  async requestKeyframe(): Promise<void> {
    if (this.currentState !== "active") {
      return;
    }

    if (!this.videoSubscriber || this.videoSubscriber.state !== "active") {
      return;
    }

    // draft-ietf-moq-transport-19 §10.2.18:
    // "A subscriber MUST NOT send this parameter in PUBLISH_OK or
    //  REQUEST_UPDATE if the Track did not include the DYNAMIC_GROUPS
    //  Property with value 1."
    if (!supportsDynamicGroups(this.videoSubscriber.trackProperties)) {
      throw new Error(
        "cannot request keyframe: track did not include DYNAMIC_GROUPS property with value 1",
      );
    }

    // REQUEST_UPDATE で NEW_GROUP_REQUEST を送信
    // draft-ietf-moq-transport-19 §10.2.18 (NEW_GROUP_REQUEST = 0x32)
    await this.videoSubscriber.update({
      parameters: [
        {
          type: 0x32,
          value: new Uint8Array([0x01]),
        },
      ],
    });

    // デコーダーをキーフレーム待ち状態にリセット
    this.videoDecoder?.resetKeyframeWait();
  }

  /**
   * リソースを解放する
   */
  async close(): Promise<void> {
    if (this.currentState === "closed") {
      return;
    }

    // デコーダーを閉じる
    this.audioDecoder?.close();
    this.videoDecoder?.close();

    // VideoTrackGenerator を閉じる
    if (this.videoWriter) {
      try {
        await this.videoWriter.close();
      } catch {
        // 無視
      }
    }

    // AudioContext を閉じる
    if (this.audioContext) {
      await this.audioContext.close();
    }

    // セッションを閉じる
    if (this.session) {
      await this.session.close();
    }

    this.outputStream = null;
    this.setState("closed");
    this.callbacks.onClose?.();
  }

  /**
   * 統計情報を取得する
   */
  getStats(): MediaReceiverStats {
    return {
      audio: this.options.audio ? { ...this.audioStats } : null,
      video: this.options.video ? { ...this.videoStats } : null,
    };
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

  /**
   * Catalog を subscribe して受信を待つ
   *
   * draft-ietf-moq-msf-01 §5: Subscribers accessing the catalog MUST use
   * SUBSCRIBE with a Joining FETCH (offset = 0) in order to obtain the latest
   * complete catalog along with all subsequent catalog objects, including
   * delta updates, that follow.
   *
   * MSF offset = 0 は draft-ietf-moq-transport-19 §10.12.2.1 の Relative Joining
   * Start = 0（Start Location = {Joining Location.Group, 0}）に対応する。
   * Absolute Joining Start = 0（{0, 0}）とは別物であるため、`type: "relative"` を使う。
   * §5 の precede-latest MUST ignore は Joining FETCH 正規経路で満たす想定とし、
   * Location 比較ゲートは実装しない。
   */
  private async subscribeCatalog(): Promise<void> {
    if (!this.session) {
      throw new Error("session not connected");
    }

    const namespace = this.options.namespace;

    // Catalog 受信を待つ Promise を作成
    // タイムアウトは「未 resolve」で reject する。FETCH フェーズ中にフルが来ても
    // resolve しない契約のため、`!receivedCatalog` だけではフェーズ未完了時にハングする。
    const catalogPromise = new Promise<Catalog>((resolve, reject) => {
      this.catalogResolve = resolve;

      setTimeout(() => {
        if (this.catalogResolve !== null) {
          this.catalogResolve = null;
          // 失敗後に live object が永久バッファされないようフェーズ状態を解除する
          this.catalogFetchInProgress = false;
          this.pendingCatalogObjects = [];
          reject(new Error("catalog receive timeout"));
        }
      }, CATALOG_RECEIVE_TIMEOUT);
    });

    // FETCH フェーズ用フラグは session.subscribe 呼び出し前に立てる
    // (SUBSCRIBE_OK までの race で live がバッファを迂回するのを防ぐ)
    this.catalogFetchInProgress = true;
    this.pendingCatalogObjects = [];

    // Catalog サブスクライバー
    // draft-ietf-moq-msf-01 §5: SUBSCRIBE with Joining FETCH (offset = 0) MUST
    this.catalogSubscriber = await this.session.subscribe(
      namespace,
      CATALOG_TRACK_NAME,
      {
        object: (obj) => {
          // FETCH フェーズ中の live SUBSCRIBE オブジェクトはバッファする
          if (this.catalogFetchInProgress) {
            this.pendingCatalogObjects.push(obj);
            return;
          }
          this.handleCatalogObject(obj);
        },
        end: () => {
          // Catalog トラック終了
        },
        error: (error) => this.callbacks.onError?.(error),
      },
      {
        joiningFetch: {
          type: "relative",
          start: 0n,
          // FETCH 経由は即時適用。live は object コールバック側でバッファする
          onObject: (obj: MoqtObject) => this.handleCatalogObject(obj),
          onEnd: () => {
            this.finishCatalogFetchPhase();
          },
          onError: (_error: Error) => {
            // FETCH 失敗時もバッファを破棄せずドレインする（Catalog は初回待ちのため）
            this.finishCatalogFetchPhase();
          },
        } satisfies JoiningFetchOptions,
      },
    );

    // largestLocation 無し時は session 側が subscribe 完了前に onEnd を呼ぶ
    // (draft-ietf-moq-transport-19 Joining FETCH 未開始相当)。追加の後処理は不要。

    // Catalog を受信するまで待つ
    await catalogPromise;
  }

  /**
   * Catalog Joining FETCH フェーズを終了する
   *
   * live バッファを順適用（ドレイン）してからフラグを下ろし、
   * その時点でフルカタログがあれば catalogResolve する。
   */
  private finishCatalogFetchPhase(): void {
    if (!this.catalogFetchInProgress) {
      return;
    }

    const pending = this.pendingCatalogObjects;
    this.pendingCatalogObjects = [];
    for (const pendingObj of pending) {
      this.handleCatalogObject(pendingObj);
    }

    this.catalogFetchInProgress = false;
    this.tryResolveCatalog();
  }

  /**
   * catalogResolve 契約に従い、未解決ならフルカタログで resolve する
   *
   * FETCH フェーズ中は resolve しない。フェーズ終了後に receivedCatalog が
   * あれば resolve。終了時点で null なら、後続の初回フル適用時に呼ばれる。
   */
  private tryResolveCatalog(): void {
    if (this.catalogFetchInProgress) {
      return;
    }
    if (this.catalogResolve === null || this.receivedCatalog === null) {
      return;
    }
    this.catalogResolve(this.receivedCatalog);
    this.catalogResolve = null;
  }

  /**
   * Catalog からトラック情報を取得する
   */
  private extractTrackInfo(): void {
    if (!this.receivedCatalog) {
      throw new Error("catalog not received");
    }

    // Audio トラック情報を取得
    if (this.options.audio) {
      const audioTrackName = this.options.audio.trackName ?? DEFAULT_AUDIO_TRACK_NAME;
      const audioTracks = getAudioTracks(this.receivedCatalog);
      this.audioTrackInfo =
        audioTracks.find((t) => t.name === audioTrackName) ?? audioTracks[0] ?? null;
    }

    // Video トラック情報を取得
    if (this.options.video) {
      const videoTrackName = this.options.video.trackName ?? DEFAULT_VIDEO_TRACK_NAME;
      const videoTracks = getVideoTracks(this.receivedCatalog);
      this.videoTrackInfo =
        videoTracks.find((t) => t.name === videoTrackName) ?? videoTracks[0] ?? null;
    }
  }

  private createOutputStream(): void {
    this.outputStream = new MediaStream();

    // Audio 出力の設定
    if (this.audioTrackInfo) {
      const sampleRate = this.audioTrackInfo.samplerate ?? DEFAULT_AUDIO_SAMPLE_RATE;
      this.audioContext = new AudioContext({
        sampleRate,
      });
      // ブラウザの自動再生ポリシー対応
      if (this.audioContext.state === "suspended") {
        void this.audioContext.resume();
      }
      this.audioDestination = this.audioContext.createMediaStreamDestination();
      const audioTrack = this.audioDestination.stream.getAudioTracks()[0];
      if (audioTrack) {
        this.outputStream.addTrack(audioTrack);
      }
    }

    // Video 出力の設定 (MediaStreamTrackGenerator を使用)
    if (this.videoTrackInfo) {
      this.videoTrackGenerator = new MediaStreamTrackGenerator({ kind: "video" });
      this.videoWriter = this.videoTrackGenerator.writable.getWriter();
      this.outputStream.addTrack(this.videoTrackGenerator);
    }
  }

  private async setupDecoders(): Promise<void> {
    const useWorker = this.options.useWorker ?? true;

    // 音声デコーダー
    if (this.audioTrackInfo) {
      this.audioDecoder = new AudioDecoderWrapper(useWorker, {
        output: (data) => this.handleAudioDecodedData(data),
        error: (error) => this.callbacks.onError?.(error),
      });

      // Catalog または options から codec を取得
      let audioCodec: AudioCodecType;
      if (this.options.audio?.codec) {
        audioCodec = this.options.audio.codec;
      } else if (this.audioTrackInfo.codec) {
        audioCodec = parseAudioCodec(this.audioTrackInfo.codec);
      } else {
        throw new Error("audio codec not specified and not found in catalog");
      }

      const sampleRate = this.audioTrackInfo.samplerate ?? DEFAULT_AUDIO_SAMPLE_RATE;
      const channels = this.audioTrackInfo.channelConfig
        ? Number.parseInt(this.audioTrackInfo.channelConfig, 10)
        : DEFAULT_AUDIO_CHANNELS;

      await this.audioDecoder.configure(audioCodec, sampleRate, channels);
      this.audioDecoderConfigured = true;
    }

    // 映像デコーダー
    if (this.videoTrackInfo) {
      this.videoDecoder = new VideoDecoderWrapper(useWorker, {
        output: (data) => this.handleVideoDecodedData(data),
        error: (error) => {
          this.callbacks.onError?.(error);
          // エラー後にデコーダーをリセット
          void this.videoDecoder?.reset();
        },
      });

      // Catalog または options から codec を取得
      let videoCodec: VideoCodecType;
      if (this.options.video?.codec) {
        videoCodec = this.options.video.codec;
      } else if (this.videoTrackInfo.codec) {
        videoCodec = parseVideoCodec(this.videoTrackInfo.codec);
      } else {
        throw new Error("video codec not specified and not found in catalog");
      }

      const width = this.videoTrackInfo.width ?? 640;
      const height = this.videoTrackInfo.height ?? 480;

      await this.videoDecoder.configure(videoCodec, width, height);
      this.videoDecoderConfigured = true;
    }
  }

  /**
   * track の authInfo に応じて Authorization Token を解決する
   *
   * draft-ietf-moq-msf-01 §5.2.42: authInfo の存在は subscribe 時に認可トークンが必要であるシグナル。
   * §11.4.2: トークン取得は仕様の対象外のため、getAuthorizationToken コールバックで注入する。
   * §11.4.4: トークンを取得できない場合はエラーを呼び出し元に伝播する。
   */
  private async resolveTrackAuthorizationToken(
    track: CatalogTrack | null,
  ): Promise<AuthorizationToken | undefined> {
    return resolveAuthorizationToken(track?.authInfo, this.options.getAuthorizationToken);
  }

  /**
   * メディアトラックを subscribe する
   */
  private async subscribeMediaTracks(): Promise<void> {
    if (!this.session) {
      throw new Error("session not connected");
    }

    const namespace = this.options.namespace;
    const joiningFetchEnabled = this.options.joiningFetch ?? false;

    // 音声サブスクライバー
    if (this.audioTrackInfo) {
      const trackName = this.audioTrackInfo.name;
      // draft-ietf-moq-msf-01 §11.4.3: authInfo を持つ track にはトークンを MUST 付与
      const authorizationToken = await this.resolveTrackAuthorizationToken(this.audioTrackInfo);
      this.audioSubscriber = await this.session.subscribe(
        namespace,
        trackName,
        {
          object: (obj) => this.handleAudioObject(obj),
          end: () => {
            // トラック終了
          },
          error: (error) => this.callbacks.onError?.(error),
        },
        { authorizationToken },
      );
    }

    // 映像サブスクライバー
    if (this.videoTrackInfo) {
      const trackName = this.videoTrackInfo.name;
      const subscribeOptions: SubscribeOptions = {};

      // draft-ietf-moq-msf-01 §11.4.3: authInfo を持つ track にはトークンを MUST 付与
      subscribeOptions.authorizationToken = await this.resolveTrackAuthorizationToken(
        this.videoTrackInfo,
      );

      if (joiningFetchEnabled) {
        // Joining Fetch 有効時は FETCH 完了まで SUBSCRIBE オブジェクトをバッファリング
        // SUBSCRIBE_OK に largestLocation があれば FETCH が送信される
        subscribeOptions.joiningFetch = {
          type: "relative",
          start: 0n,
          onObject: (obj: MoqtObject) => {
            // FETCH から受信したオブジェクトは即座にデコード
            this.handleVideoObject(obj);
          },
          onEnd: () => {
            // FETCH 完了 → バッファリングしていた SUBSCRIBE オブジェクトを処理
            this.videoFetchInProgress = false;
            for (const pendingObj of this.pendingVideoObjects) {
              this.handleVideoObject(pendingObj);
            }
            this.pendingVideoObjects = [];
          },
          onError: () => {
            // FETCH エラー（LARGEST_OBJECT がない場合など）
            // バッファリングを無効化してリアルタイム配信を待つ
            this.videoFetchInProgress = false;
            this.pendingVideoObjects = [];
          },
        };
        // FETCH が送信されるかどうかは SUBSCRIBE_OK 後に確定
        // 一旦バッファリングモードに入り、onError で解除される
        this.videoFetchInProgress = true;
      }

      this.videoSubscriber = await this.session.subscribe(
        namespace,
        trackName,
        {
          object: (obj) => {
            // Joining Fetch 中は SUBSCRIBE オブジェクトをバッファリング
            if (this.videoFetchInProgress) {
              this.pendingVideoObjects.push(obj);
              return;
            }
            this.handleVideoObject(obj);
          },
          end: () => {
            // トラック終了
          },
          error: (error) => this.callbacks.onError?.(error),
        },
        subscribeOptions,
      );

      // SUBSCRIBE_OK に largestLocation がない場合は FETCH が送信されない
      // この場合はバッファリングモードを解除
      if (joiningFetchEnabled && this.videoSubscriber.largestLocation === null) {
        this.videoFetchInProgress = false;
        // onError が呼ばれるのでここでは何もしない
      }
    }
  }

  /**
   * Catalog オブジェクトを処理する
   */
  private handleCatalogObject(obj: MoqtObject): void {
    const result = processCatalogPayload(this.receivedCatalog, obj.payload);

    if (result.kind === "error") {
      this.callbacks.onError?.(result.error);
      return;
    }

    if (result.kind === "ignored") {
      return;
    }

    // full / delta: 適用後カタログで置換し onCatalog を発火する
    this.receivedCatalog = result.catalog;
    this.callbacks.onCatalog?.(this.receivedCatalog);
    this.tryResolveCatalog();
  }

  private handleAudioObject(obj: MoqtObject): void {
    if (!this.audioDecoder || !this.audioDecoderConfigured) return;

    this.audioStats.framesReceived++;
    this.audioStats.bytesReceived += obj.payload.length + (obj.properties?.length ?? 0);

    // LOC から情報を取得
    // Track Property（SUBSCRIBE_OK 由来）と Object Property の両方を探索し、Object を優先する
    let timestamp = 0;
    const locProperties = LOC.resolveAudioProperties(
      this.audioSubscriber?.trackProperties,
      obj.properties,
    );
    if (locProperties.timestamp !== undefined) {
      timestamp = Number(locProperties.timestamp);
    }

    // デコード
    this.audioDecoder.decode(obj.payload, "key", timestamp, 0);
  }

  private handleVideoObject(obj: MoqtObject): void {
    if (!this.videoDecoder || !this.videoDecoderConfigured) return;

    // LOC から情報を取得
    // Track Property（SUBSCRIBE_OK 由来）と Object Property の両方を探索し、Object を優先する
    let isKeyFrame = false;
    let timestamp = 0;
    const locProperties = LOC.resolveVideoProperties(
      this.videoSubscriber?.trackProperties,
      obj.properties,
    );
    if (locProperties.timestamp !== undefined) {
      timestamp = Number(locProperties.timestamp);
    }
    if (locProperties.frameMarking) {
      isKeyFrame = locProperties.frameMarking.isIndependent;
    }

    this.videoStats.framesReceived++;
    this.videoStats.bytesReceived += obj.payload.length + (obj.properties?.length ?? 0);
    if (isKeyFrame) {
      this.videoStats.keyFramesReceived++;
    }

    // デコード
    this.videoDecoder.decode(obj.payload, isKeyFrame ? "key" : "delta", timestamp, 0);
  }

  private handleAudioDecodedData(data: { data: AudioData }): void {
    if (!this.audioContext || !this.audioDestination) {
      data.data.close();
      return;
    }

    // AudioData を AudioBuffer に変換して再生
    const audioData = data.data;
    const numberOfChannels = audioData.numberOfChannels;
    const sampleRate = audioData.sampleRate;
    const numberOfFrames = audioData.numberOfFrames;

    const audioBuffer = this.audioContext.createBuffer(
      numberOfChannels,
      numberOfFrames,
      sampleRate,
    );

    // 各チャンネルのデータをコピー
    for (let channel = 0; channel < numberOfChannels; channel++) {
      const channelData = new Float32Array(numberOfFrames);
      audioData.copyTo(channelData, { planeIndex: channel, format: "f32-planar" });
      audioBuffer.copyToChannel(channelData, channel);
    }

    // AudioBufferSourceNode で再生
    const source = this.audioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.audioDestination);
    source.start();

    audioData.close();
  }

  private handleVideoDecodedData(data: { frame: VideoFrame }): void {
    if (!this.videoWriter) {
      data.frame.close();
      return;
    }

    // VideoFrame を MediaStreamTrackGenerator に書き込む
    this.videoWriter.write(data.frame).catch(() => {
      // 書き込みエラーは無視
    });
  }
}

/**
 * MediaSubscriber を作成する
 *
 * @param url - MOQT サーバーの URL (例: `moqt://example.com/moqt`)
 * @param options - 購読オプション
 * @param callbacks - コールバック
 * @returns MediaSubscriber インスタンス
 */
export async function createMediaSubscriber(
  url: string,
  options: MediaSubscriberOptions,
  callbacks?: MediaSubscriberCallbacks,
): Promise<MediaSubscriber> {
  if (!options.audio && !options.video) {
    throw new Error("at least one of audio or video must be specified");
  }

  return new MediaSubscriberImpl(url, options, callbacks);
}

// 型のエクスポート
export type {
  MediaSubscriber,
  MediaSubscriberOptions,
  MediaSubscriberCallbacks,
  MediaSubscriberState,
  MediaReceiverStats,
  AudioReceiverStats,
  VideoReceiverStats,
  AudioSubscribeOptions,
  VideoSubscribeOptions,
};
