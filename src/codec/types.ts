/**
 * コーデック関連の型定義
 */

// オーディオコーデック
export type AudioCodecType = "opus" | "aac";

// ビデオコーデック
export type VideoCodecType = "h264" | "h265" | "vp8" | "vp9" | "av1";

// MediaPublisher の状態
export type MediaPublisherState =
  | "created"
  | "ready"
  | "publishing"
  | "paused"
  | "stopped"
  | "closed";

// MediaSubscriber の状態
export type MediaSubscriberState = "created" | "subscribing" | "active" | "stopped" | "closed";

// オーディオ統計
export interface AudioStats {
  framesSent: number;
  bytesSent: number;
  currentGroupId: number;
}

// 受信側オーディオ統計
export interface AudioReceiverStats {
  framesReceived: number;
  bytesReceived: number;
}

// ビデオ統計
export interface VideoStats {
  framesSent: number;
  keyFramesSent: number;
  bytesSent: number;
  currentGroupId: number;
}

// 受信側ビデオ統計
export interface VideoReceiverStats {
  framesReceived: number;
  keyFramesReceived: number;
  bytesReceived: number;
}

// 送信側メディア統計
export interface MediaStats {
  audio: AudioStats | null;
  video: VideoStats | null;
}

// 受信側メディア統計
export interface MediaReceiverStats {
  audio: AudioReceiverStats | null;
  video: VideoReceiverStats | null;
}

// オーディオ配信オプション
export interface AudioPublishOptions {
  trackName?: string;
  codec: AudioCodecType;
  bitrate: number;
  sampleRate?: number;
  channels?: number;
}

// ビデオ配信オプション
export interface VideoPublishOptions {
  trackName?: string;
  codec: VideoCodecType;
  bitrate: number;
  framerate?: number;
  keyframeInterval?: number;
  width?: number;
  height?: number;
}

// オーディオ購読オプション
// codec を省略した場合は Catalog から自動取得
export interface AudioSubscribeOptions {
  trackName?: string;
  codec?: AudioCodecType;
}

// ビデオ購読オプション
// codec を省略した場合は Catalog から自動取得
export interface VideoSubscribeOptions {
  trackName?: string;
  codec?: VideoCodecType;
}

// MediaPublisher オプション
export interface MediaPublisherOptions {
  namespace: string[];
  audio?: AudioPublishOptions;
  video?: VideoPublishOptions;
  useWorker?: boolean;
  serverCertificateHashes?: ArrayBuffer[];
  // SETUP Option (Option Type 0x03) として送出する Authorization Token
  // draft-ietf-moq-transport-18 Section 10.3.1.4 (AUTHORIZATION TOKEN Setup Option)
  // SETUP では Alias Type DELETE (0x0) / USE_ALIAS (0x2) は仕様上禁止 (Section 10.2.2)
  authorizationToken?: import("../message").AuthorizationToken;
  // Pending Subgroup Stream の buffer 設定 (低レベル API の ConnectOptions.pendingSubgroup)
  // draft-ietf-moq-transport-18 §11.4.2
  // 未指定 field は DEFAULT_PENDING_SUBGROUP_BUFFER_OPTIONS で補完される
  pendingSubgroup?: Partial<import("../pendingSubgroupBuffer").PendingSubgroupBufferOptions>;
}

// MediaPublisher コールバック
export interface MediaPublisherCallbacks {
  onStateChange?: (state: MediaPublisherState) => void;
  onError?: (error: Error) => void;
  onClose?: () => void;
}

// MediaSubscriber オプション
export interface MediaSubscriberOptions {
  namespace: string[];
  audio?: AudioSubscribeOptions;
  video?: VideoSubscribeOptions;
  useWorker?: boolean;
  joiningFetch?: boolean;
  serverCertificateHashes?: ArrayBuffer[];
  // SETUP Option (Option Type 0x03) として送出する Authorization Token
  // draft-ietf-moq-transport-18 Section 10.3.1.4 (AUTHORIZATION TOKEN Setup Option)
  // SETUP では Alias Type DELETE (0x0) / USE_ALIAS (0x2) は仕様上禁止 (Section 10.2.2)
  authorizationToken?: import("../message").AuthorizationToken;
  // Pending Subgroup Stream の buffer 設定 (低レベル API の ConnectOptions.pendingSubgroup)
  // draft-ietf-moq-transport-18 §11.4.2
  // 未指定 field は DEFAULT_PENDING_SUBGROUP_BUFFER_OPTIONS で補完される
  pendingSubgroup?: Partial<import("../pendingSubgroupBuffer").PendingSubgroupBufferOptions>;
}

// MediaSubscriber コールバック
export interface MediaSubscriberCallbacks {
  onStateChange?: (state: MediaSubscriberState) => void;
  onCatalog?: (catalog: import("../msf").Catalog) => void;
  onError?: (error: Error) => void;
  onClose?: () => void;
}

// MediaPublisher インターフェース
export interface MediaPublisher {
  readonly state: MediaPublisherState;
  start(stream: MediaStream): Promise<void>;
  pause(): void;
  resume(): void;
  stop(): Promise<void>;
  requestKeyframe(): void;
  close(): Promise<void>;
  getStats(): MediaStats;
  getCatalog(): import("../msf").Catalog | null;
}

// MediaSubscriber インターフェース
export interface MediaSubscriber {
  readonly state: MediaSubscriberState;
  readonly mediaStream: MediaStream | null;
  readonly catalog: import("../msf").Catalog | null;
  start(): Promise<void>;
  stop(): Promise<void>;
  requestKeyframe(): Promise<void>;
  close(): Promise<void>;
  getStats(): MediaReceiverStats;
}

// エンコード済みチャンクデータ
export interface EncodedChunkData {
  data: Uint8Array;
  type: "key" | "delta";
  timestamp: number;
  duration: number | null;
  description?: Uint8Array;
}

// エンコーダーコールバック
export interface VideoEncoderWrapperCallbacks {
  output: (chunk: EncodedChunkData) => void;
  error: (error: Error) => void;
}

// デコード済みフレームデータ
export interface DecodedFrameData {
  frame: VideoFrame;
}

// デコーダーコールバック
export interface VideoDecoderWrapperCallbacks {
  output: (data: DecodedFrameData) => void;
  error: (error: Error) => void;
}

// オーディオエンコード済みチャンクデータ
export interface AudioEncodedChunkData {
  data: Uint8Array;
  type: "key" | "delta";
  timestamp: number;
  duration: number | null;
}

// オーディオエンコーダーコールバック
export interface AudioEncoderWrapperCallbacks {
  output: (chunk: AudioEncodedChunkData) => void;
  error: (error: Error) => void;
}

// オーディオデコード済みデータ
export interface AudioDecodedData {
  data: AudioData;
}

// オーディオデコーダーコールバック
export interface AudioDecoderWrapperCallbacks {
  output: (data: AudioDecodedData) => void;
  error: (error: Error) => void;
}
