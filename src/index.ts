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
  PlaybackDelayBreakdown,
  PlaybackTrackBreakdown,
  PlaybackUnsharedReason,
} from "./playbackTimeline";

// 音声の再生の観測値 (AudioReceiverStats.playoutTiming)。鳴るはずの時刻と鳴らなかった量
export type {
  AudioMissEvent,
  AudioMissReason,
  AudioMissTotal,
  AudioPlayoutTimingSnapshot,
} from "./audioPlayoutTimingStats";

// 分布の要約 (p50 / p95 / max)。映像と音声の時間の統計で共通に使う
export type { TimingSummary } from "./timingSummary";
