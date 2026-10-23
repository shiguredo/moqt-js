/**
 * moqt-js
 *
 * MOQT (Media over QUIC Transport) client library
 * draft-ietf-moq-transport-22
 */

// 接続 (draft-ietf-moq-transport-22 Section 6.2)
export { connect } from "./connect";

// MOQT URI / Fragment Identifier (draft-ietf-moq-transport-22 §6.1 / §6.1.1)
export { parseFragment, type MoqtFragment, type NormalizedMoqtUri } from "./moqtUri";

// Track Namespace の送信前の検証 (draft-ietf-moq-transport-22 §8.7 / §2.4.3 / §6.5)
// 接続の前に、Track Namespace の構造の制約 (32 フィールド上限 / 各フィールド 1 バイト以上 /
// 4,096 バイト上限) と予約 namespace を検証できるよう、Request を送るときに使う検証を
// 公開する。Full Track Name の 4,096 バイト上限は Track Name と合わせた長さで決まるため、
// Request の送信時に検証する。
export { validateTrackNamespaceForSend } from "./session/params";

// 公開型の再エクスポート
export type {
  Session,
  SessionStatistics,
  ConnectCallbacks,
  ConnectOptions,
  CertificateHash,
  DebugMessage,
  PublishCallbacks,
  PublishOptions,
  SubgroupStreamEnd,
  PublishDoneInfo,
  SubscribeCallbacks,
  SubscribeOptions,
  SubscribeTracksOptions,
  FillRequestOptions,
  FetchCallbacks,
  FetchOptions,
  TrackStatusOptions,
  TrackStatusResult,
  NamespacePublication,
  NamespacePublicationCallbacks,
  NamespaceSubscriptionCallbacks,
  NamespaceSubscription,
  NamespaceUpdateOptions,
  PublishNamespaceOptions,
  TracksSubscriptionCallbacks,
  TracksSubscription,
  TracksUpdateOptions,
  MoqtObject,
} from "./session";
export { toHttpVersionLabel, type HttpVersionLabel } from "./httpVersion";

// Pending Subgroup Buffer オプションの再エクスポート (draft-ietf-moq-transport-22 §11.3.1)
export {
  type PendingSubgroupBufferOptions,
  DEFAULT_PENDING_SUBGROUP_BUFFER_OPTIONS,
} from "./pendingSubgroupBuffer";

// メッセージ型の再エクスポート
export type { LocationFilter, Location, Parameter } from "./message";

// PUBLISH_DONE の Status Code (draft-ietf-moq-transport-22 §9.9 / §12.4)
// 購読の終了理由 (SubscribeCallbacks.end の PublishDoneInfo) をアプリが名前で判定できるように
// 公開する。未知の code は §13 (Grease) により INTERNAL_ERROR に正規化した値が渡る。
export { PublishDoneStatusCode, isPublishDoneErrorStatus } from "./message";

// Authorization Token の再エクスポート (draft-ietf-moq-transport-22 Section 9.20.2)
export {
  type AuthorizationToken,
  type AuthorizationTokenDelete,
  type AuthorizationTokenRegister,
  type AuthorizationTokenUseAlias,
  type AuthorizationTokenUseValue,
  AuthorizationTokenAliasType,
  decodeAuthorizationToken,
  encodeAuthorizationToken,
} from "./message";
export type {
  Publisher,
  PublishStateNotifyOptions,
  SendObjectParams,
  SendDatagramParams,
} from "./publisher";
export type { Subscriber, RequestUpdateOptions } from "./subscriber";
export type { Fetcher } from "./fetcher";

// エラー型の再エクスポート
export {
  MoqtError,
  SessionError,
  RequestError,
  ClosedSubgroupError,
  SessionErrorCode,
  RequestErrorCode,
  DataStreamErrorCode,
  type RedirectInfo,
} from "./error";

// LOC の再エクスポート (draft-ietf-moq-loc)
// モジュール全体を名前空間付きで公開する (公開 API として導入済み)
export * as LOC from "./loc";

// MSF の再エクスポート (draft-ietf-moq-msf)
// 公開するのは Catalog / Timeline / msf fragment の解析 / トラック検索と関連する型・定数のみ。
// 検証・range・Group ID などの内部ヘルパーはモジュール内に留める。
export {
  // Catalog
  encodeCatalog,
  encodeCatalogDelta,
  decodeCatalogMessage,
  applyCatalogDelta,
  createCatalog,
  createCompleteCatalog,
  catalogAuthInfoForSetupToken,
  // Timeline
  encodeMediaTimeline,
  decodeMediaTimeline,
  encodeEventTimeline,
  decodeEventTimeline,
  // msf fragment の解析
  parseMsfFragmentValue,
  // トラック検索
  resolveInitData,
  getVideoTracks,
  getAudioTracks,
  getTrackByName,
  getTracksByAltGroup,
  getTracksByRenderGroup,
  selectTrackByMaxBitrate,
  selectTrackByMaxResolution,
  selectHighestBitrateTrack,
  selectLowestBitrateTrack,
  // 定数
  MSF_VERSION,
  CATALOG_TRACK_NAME,
  RESERVED_TRACK_ROLES,
  // 型
  type MsfVersion,
  type PackagingType,
  type TrackRole,
  type CipherSuite,
  type Buffers,
  type InitDataEntry,
  type AccessibilityDescriptor,
  type AuthInfo,
  type MediaTimelineTemplate,
  type CatalogTrack,
  type PublishTrack,
  type RemoveTrack,
  type Catalog,
  type CatalogDeltaOperation,
  type CatalogDelta,
  type CatalogMessage,
  type MediaTimelineEntry,
  type EventTimelineEntry,
  type MsfFragmentValue,
} from "./msf";

// MOQ Log の再エクスポート (draft-jennings-moq-log / draft-ietf-moq-msf §9)
// モジュール全体を名前空間付きで公開する (公開 API として導入済み)
export * as MOQLOG from "./moqlog";

// MOQ Metrics の再エクスポート (draft-jennings-moq-metrics / draft-ietf-moq-msf §10)
// モジュール全体を名前空間付きで公開する (公開 API として導入済み)
export * as MOQMETRICS from "./moqmetrics";

// C4M の再エクスポート (draft-ietf-moq-c4m-01)
// CBOR / COSE / CAT のコーデックを名前空間付きで公開する。署名 / 検証は
// Web Crypto API だけを使い、外部依存を持たない。
export * as C4M from "./c4m";

// バージョン
export { version, MOQT_IMPLEMENTATION_VALUE } from "./version";

// 高レベル MediaStream API
export {
  createMediaPublisher,
  type MediaPublisher,
  type MediaPublisherOptions,
  type MediaPublisherCallbacks,
  type MediaPublisherState,
  type MediaStats,
  type AudioStats,
  type VideoStats,
  type AudioPublishOptions,
  type AudioDelivery,
  type VideoPublishOptions,
} from "./createMediaPublisher";

export {
  catalogFetchFilter,
  createMediaSubscriber,
  type MediaSubscriber,
  type MediaSubscriberOptions,
  type MediaSubscriberCallbacks,
  type MediaSubscriberState,
  type MediaReceiverStats,
  type AudioReceiverStats,
  type VideoReceiverStats,
  type AvSyncStats,
  type AudioSubscribeOptions,
  type VideoSubscribeOptions,
  // 保留キューの上限の再エクスポート (初期 configure の完了まで保留する Object)
  type PendingObjectQueueOptions,
  DEFAULT_PENDING_OBJECT_QUEUE_OPTIONS,
} from "./createMediaSubscriber";

// コーデック型
export type { AudioCodecType, VideoCodecType } from "./codec/types";

// VideoFrame ソース (MediaStreamTrackProcessor フォールバック)
export {
  createVideoFrameSource,
  isMediaStreamTrackProcessorAvailable,
  type VideoFrameSource,
} from "./frameSource";

// AudioData ソース (MediaStreamTrackProcessor / Web Audio AudioWorklet の 2 経路)
export {
  AUDIO_FRAME_BLOCK_MS,
  audioFrameOffsetMicros,
  buildAudioDataInit,
  concatPlanarChannels,
  createAudioFrameSource,
  isAudioFrameSourceAvailable,
  resolveAudioBlockFrames,
  type AudioFrameSource,
  type AudioFrameSourceOptions,
  type BuildAudioDataInitOptions,
} from "./audioSource";

// MOQT 拡張の再エクスポート (draft-ietf-moq-transport-22 Section 10 (MOQT Properties))
export {
  MOQTPropertyId,
  TrackPropertyId,
  type Property,
  type PriorGroupIdGap,
  type PriorObjectIdGap,
  type ImmutableProperties,
  type ParsedProperties,
  encodeProperties,
  supportsDynamicGroups,
} from "./properties";

// Data Stream の型と関数の再エクスポート
export {
  // Subgroup Header
  SubgroupHeaderType,
  type SubgroupHeader,
  encodeSubgroupHeader,
  decodeSubgroupHeader,
  hasEndOfGroup,
  hasPropertiesPresent,
  // Object Fields
  type DecodedObjectFields,
  encodeObjectFields,
  decodeObjectFields,
  // Object Datagram
  DatagramType,
  type ObjectDatagram,
  encodeObjectDatagram,
  decodeObjectDatagram,
  // Fetch Header
  FetchHeaderType,
  type FetchHeader,
  decodeFetchHeader,
  // Fetch Object Fields
  FetchSerializationFlags,
  type EndOfRangeType,
  type FetchObjectFields,
  type DecodedFetchObject,
  type FetchObjectContext,
  decodeFetchObjectFields,
} from "./dataStream";

// A/V 同期の遅延の内訳 (AvSyncStats.delays)。遅延の解析に使う
export type {
  PlayoutDelayBreakdown,
  PlayoutTrackBreakdown,
  PlayoutUnsharedReason,
} from "./playout/timeline";

// 音声の目標遅延を閉ループで決めた状態 (AvSyncStats.delays.audioDelayFeedback)。
// 適用中の目標と、その理由
export type {
  AudioDelayFeedbackObservation,
  AudioDelayFeedbackReason,
  AudioDelayFeedbackSnapshot,
} from "./playout/audioDelayFeedback";

// 音声の再生の計器 (AudioPlayoutTimingStats) へ記録するときの型
export type { AudioPlayoutBasis } from "./playout/audioPlayout";

// 音声の再生の観測 (鳴るはずの時刻・鳴り始める時刻・鳴らなかった量)。再生の入口
// (MediaPlayout) の `audio.timing` に渡す計器であり、利用者が自分の実行周期で画面へ出す
// (docs/HIGH_LEVEL_API.md)。再生の観測値の型 (AudioReceiverStats.playoutTiming) も同じ
// モジュールが持つ
export {
  AudioPlayoutTimingStats,
  AUDIO_PLAYOUT_TIMING_WINDOW_MS,
  AUDIO_PLAYOUT_BOUNDARY_STEP_THRESHOLD,
  AUDIO_MISS_REASONS,
  EMPTY_AUDIO_PLAYOUT_TIMING,
  formatAudioMissEvent,
  type AudioMissEvent,
  type AudioMissReason,
  type AudioMissTotal,
  type AudioPlayoutMiss,
  type AudioPlayoutTimingSnapshot,
} from "./playout/audioPlayoutTimingStats";

// 受信側の音声が live から遅れたときに、復号器を作り直して追いついた観測
// (AudioReceiverStats.playoutCatchUp)。判定そのものは再生の入口の内部で行う
export {
  AUDIO_RECEIVE_CATCH_UP_MIN_MS,
  AUDIO_RECEIVE_CATCH_UP_GROWTH_MS,
  AUDIO_RECEIVE_CATCH_UP_JUMP_MS,
  AUDIO_RECEIVE_CATCH_UP_FLOOR_WINDOW_MS,
  AUDIO_RECEIVE_CATCH_UP_CONFIRM_MS,
  AUDIO_RECEIVE_CATCH_UP_COOLDOWN_MS,
  AUDIO_RECEIVE_CATCH_UP_SKIP_MIN_MS,
  EMPTY_AUDIO_RECEIVE_CATCH_UP,
  type AudioReceiveCatchUpStats,
} from "./playout/audioReceiveCatchUp";

// 音声の再生の入口 (MediaPlayout) の型。Web Audio は AudioPlayoutOutput として注入し、
// 鳴らし切る待ちの設定と結果は drainAudio が受け取る・返す。組み立て (時間軸への記録・
// 目標の決定・予約・計器への記録) は入口の内部で行う
export { type AudioPlayoutContext, type AudioPlayoutOutput } from "./playout/audioPlayoutSession";

// 映像の表示の入口 (MediaPlayout) の型。表示の出し先 (MediaStreamTrackGenerator / canvas)
// と表示周期、捨てたフレームの記録先は注入し、復号へ渡した入力の情報は
// trackVideoDecodeInput で記録する。組み立て (対応表・時間軸への記録・表示の選択・計器への
// 記録) は入口の内部で行う
export {
  type VideoPlayoutOutput,
  type VideoPlayoutPacing,
  type VideoPlayoutTiming,
} from "./playout/videoPlayoutSession";

// 復号済みの音声と映像の再生の入口。時間軸・音声の再生の組み立て・映像の表示の組み立て・
// 計器・復号へ渡した入力の対応表を 1 か所にまとめる。AudioContext と映像の出し先を渡し、
// 復号へ渡す直前に入力を記録して、復号の出力を push するだけで使える。
// ライブラリ (createMediaSubscriber) と moqt-devtools を含む呼び出し側は、この入口だけを
// 使う (個々の組み立てを直接使わない)
export { createMediaPlayout } from "./playout/mediaPlayout";
export {
  AUDIO_PLAYOUT_DRAIN_CLOSE_MAX_MS,
  AUDIO_PLAYOUT_DRAIN_MAX_MS,
} from "./playout/audioPlayoutSession";
export type {
  MediaPlayout,
  MediaPlayoutOptions,
  MediaPlayoutAudioOptions,
  MediaPlayoutVideoOptions,
  MediaPlayoutDecodeInputOptions,
  MediaPlayoutAudioDecodeInput,
  MediaPlayoutVideoDecodeInput,
  PlayoutTimestampKind,
  MediaPlayoutDrainOptions,
  MediaPlayoutDrainStats,
  MediaPlayoutAudioResult,
  MediaPlayoutVideoResult,
  MediaPlayoutStats,
  MediaPlayoutAudioStats,
  MediaPlayoutVideoStats,
} from "./playout/mediaPlayout";

// 映像の表示待ちのキューの上限の既定値 (MediaPlayoutOptions.maxQueuedFrames)
export { JITTER_BUFFER_MAX_QUEUED_FRAMES } from "./playout/buffer";

// 購読側の復号前の再生遅延 (MediaSubscriberOptions.preDecodeDelayMs) の上限と保持上限
export {
  MAX_PRE_DECODE_DELAY_MS,
  PRE_DECODE_QUEUE_MAX_BYTES,
  PRE_DECODE_QUEUE_MAX_OBJECTS,
} from "./playout/preDecodeDelay";

// 映像 Object を復号してよいかの判定 (Group の順序と参照するフレームの欠落)
export { VideoDecodeOrder, priorObjectIdGapOf } from "./videoDecodeOrder";

// 前の Group の Subgroup の stream が開いている間、次の Group の Object を保留する
export { GroupSwitchGate } from "./groupSwitchGate";

// relay の cache から追いつく途中の Object を、SUBSCRIBE_OK の LARGEST_OBJECT を境界に
// 選別する (draft-ietf-moq-transport-22 Section 9.20.17)
export { CatchUpGate, type CatchUpDecision } from "./catchUpGate";

// 分布の要約 (p50 / p95 / max)。映像と音声の時間の統計で共通に使う
export type { TimingSummary } from "./playout/timingSummary";
// 音声の TIMESTAMP を壁時計へ合わせるための観測 (AudioStats.timestampOffset)。
// 「読み出した壁時計 - AudioData.timestamp」の推移
export type { AudioTimestampOffsetStats } from "./audioTimestampClock";

// 音声が live から遅れたときに古いフレームを捨てて追いつく判定と観測
// (AudioStats.catchUp。MediaPublisherOptions.audioCatchUp で方針を選ぶ)
export {
  AudioPublishCatchUp,
  AUDIO_PUBLISH_CATCH_UP_MIN_MS,
  AUDIO_PUBLISH_CATCH_UP_GROWTH_MS,
  AUDIO_PUBLISH_CATCH_UP_RESUME_MS,
  AUDIO_PUBLISH_CATCH_UP_CONFIRM_MS,
  AUDIO_PUBLISH_CATCH_UP_QUEUE_CONFIRM_FRAMES,
  AUDIO_PUBLISH_CATCH_UP_COOLDOWN_MS,
  AUDIO_PUBLISH_CATCH_UP_PENDING_TIMEOUT_MS,
  type AudioPublishCatchUpPolicy,
  type AudioPublishCatchUpStats,
  type AudioPublishCatchUpOptions,
  type AudioPublishCatchUpFrameInput,
  type AudioPublishCatchUpChunkInput,
  type AudioPublishCatchUpChunkResult,
} from "./audioPublishCatchUp";
