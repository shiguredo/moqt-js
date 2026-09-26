/**
 * コーデック関連の型定義
 */

// オーディオコーデック
export type AudioCodecType = "opus" | "aac";

// ビデオコーデック
export type VideoCodecType = "h264" | "h265" | "vp8" | "vp9" | "av1";

// MediaPublisher の状態
export type MediaPublisherState = "created" | "publishing" | "paused" | "stopped" | "closed";

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
  // エンコードが追いつかないため待たずに破棄したフレーム数 (閾値は createMediaPublisher の判定)
  droppedFrames: number;
  keyFramesSent: number;
  bytesSent: number;
  currentGroupId: number;
}

// 受信側ビデオ統計
export interface VideoReceiverStats {
  framesReceived: number;
  keyFramesReceived: number;
  bytesReceived: number;
  // 復号中の Group より古い Group の Object、または重複・遅着の Object として復号せずに
  // 捨てたフレーム数 (VideoDecodeOrder の stale)
  staleFramesDropped: number;
  // 参照するフレームが欠けているためキーフレームを待つ間に捨てたフレーム数
  // (VideoDecodeOrder の missing-reference)
  missingReferenceFramesDropped: number;
}

// 送信側メディア統計
export interface MediaStats {
  audio: AudioStats | null;
  video: VideoStats | null;
}

// 受信側の音声と映像の同期の推定値
export interface AvSyncStats {
  // 同期ずれの推定値 (ms)。映像の表示が音声より遅れていれば正。
  // 音声は予約した時刻、映像は write した時刻の実績から求める (実際に音が出るまでの
  // 出力遅延と、映像が表示されるまでの表示周期の遅れは含まない)。
  // どちらかの実績が 1 秒より古いときは null
  skewMs: number | null;
  // 表示の遅れ (ms)。TIMESTAMP から表示時刻までの差で、時計のずれの分だけ負にもなる。
  // 基準が未確立なら null
  presentationDelayMs: number | null;
  // catalog から解決した目標遅延 (ms)。無い、または使えないときは null。
  // 実際に表示の遅れに使う値は、上限に収まらない分 (targetLatencyLimitedMs) を
  // 切り下げた値になる
  targetLatencyMs: number | null;
  // 表示の遅れの上限に収まらず切り下げた分 (ms)
  targetLatencyLimitedMs: number;
  // AudioContext.getOutputTimestamp() を使えず currentTime で代用しているか
  audioClockFallback: boolean;
}

// 受信側メディア統計
export interface MediaReceiverStats {
  audio: AudioReceiverStats | null;
  video: VideoReceiverStats | null;
  // 音声と映像の同期の推定値。片方しか購読していない、またはどちらかが壁時計の
  // TIMESTAMP を使えないときは null
  avSync: AvSyncStats | null;
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
  // draft-ietf-moq-transport-21 Section 9.1.4 (AUTHORIZATION TOKEN Setup Option)
  // SETUP では Alias Type DELETE (0x0) / USE_ALIAS (0x2) は仕様上禁止 (Section 9.1.4)
  authorizationToken?: import("../message").AuthorizationToken;
  // Pending Subgroup Stream の buffer 設定 (低レベル API の ConnectOptions.pendingSubgroup)
  // draft-ietf-moq-transport-21 §11.3.1
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
  serverCertificateHashes?: ArrayBuffer[];
  // SETUP Option (Option Type 0x03) として送出する Authorization Token
  // draft-ietf-moq-transport-21 Section 9.1.4 (AUTHORIZATION TOKEN Setup Option)
  // SETUP では Alias Type DELETE (0x0) / USE_ALIAS (0x2) は仕様上禁止 (Section 9.1.4)
  authorizationToken?: import("../message").AuthorizationToken;
  // draft-ietf-moq-msf-01 §11.4.2: トークン取得は仕様の対象外のためコールバックで注入する。
  // §5.2.42 authInfo を持つ track の subscribe 時に呼ばれ、AUTHORIZATION_TOKEN を返す。
  // authInfo があるのにトークンを返せない（undefined）場合、subscribe はエラーになる（§11.4.4）。
  getAuthorizationToken?: (
    authInfo: import("../msf").AuthInfo,
  ) =>
    | import("../message").AuthorizationToken
    | undefined
    | Promise<import("../message").AuthorizationToken | undefined>;
  // Pending Subgroup Stream の buffer 設定 (低レベル API の ConnectOptions.pendingSubgroup)
  // draft-ietf-moq-transport-21 §11.3.1
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
  // AAC の AudioSpecificConfig など、デコーダーへ渡す設定 (opus では未設定)
  description?: Uint8Array;
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
