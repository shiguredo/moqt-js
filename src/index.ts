/**
 * moqt-js
 *
 * MOQT (Media over QUIC Transport) client library
 * draft-ietf-moq-transport-21
 */

// 接続 (draft-ietf-moq-transport-21 Section 6.2)
export { connect } from "./connect";

// MOQT URI / Fragment Identifier (draft-ietf-moq-transport-21 §6.1 / §6.1.1)
export { parseFragment, type MoqtFragment, type NormalizedMoqtUri } from "./moqtUri";

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
  SubscribeCallbacks,
  SubscribeOptions,
  SubscribeTracksOptions,
  FillRequestOptions,
  FetchCallbacks,
  FetchOptions,
  TrackStatusOptions,
  TrackStatusResult,
  NamespaceSubscriptionCallbacks,
  NamespaceSubscription,
  NamespaceUpdateOptions,
  TracksSubscriptionCallbacks,
  TracksSubscription,
  TracksUpdateOptions,
  MoqtObject,
} from "./session";
export { toHttpVersionLabel, type HttpVersionLabel } from "./httpVersion";

// Pending Subgroup Buffer オプションの再エクスポート (draft-ietf-moq-transport-21 §11.3.1)
export {
  type PendingSubgroupBufferOptions,
  DEFAULT_PENDING_SUBGROUP_BUFFER_OPTIONS,
} from "./pendingSubgroupBuffer";

// メッセージ型の再エクスポート
export type { LocationFilter, Location, Parameter } from "./message";

// Authorization Token の再エクスポート (draft-ietf-moq-transport-21 Section 9.20.3)
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
export type { Publisher, SendObjectParams, SendDatagramParams } from "./publisher";
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
} from "./error";

// LOC の再エクスポート (draft-ietf-moq-loc)
// モジュール全体を名前空間付きで公開する (公開 API として導入済み)
export * as LOC from "./loc";

// MSF の再エクスポート (draft-ietf-moq-msf)
// 公開するのは Catalog / Timeline と関連する型・定数のみ。
// 検証・fragment・range などの内部ヘルパーはモジュール内に留める。
export {
  // Catalog
  encodeCatalog,
  encodeCatalogDelta,
  decodeCatalogMessage,
  applyCatalogDelta,
  createCatalog,
  createCompleteCatalog,
  // Timeline
  encodeMediaTimeline,
  decodeMediaTimeline,
  encodeEventTimeline,
  decodeEventTimeline,
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
} from "./msf";

// MOQ Log の再エクスポート (draft-jennings-moq-log / draft-ietf-moq-msf §9)
// モジュール全体を名前空間付きで公開する (公開 API として導入済み)
export * as MOQLOG from "./moqlog";

// MOQ Metrics の再エクスポート (draft-jennings-moq-metrics / draft-ietf-moq-msf §10)
// モジュール全体を名前空間付きで公開する (公開 API として導入済み)
export * as MOQMETRICS from "./moqmetrics";

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
  createMediaSubscriber,
  type MediaSubscriber,
  type MediaSubscriberOptions,
  type MediaSubscriberCallbacks,
  type MediaSubscriberState,
  type MediaReceiverStats,
  type AudioReceiverStats,
  type VideoReceiverStats,
  type AudioSubscribeOptions,
  type VideoSubscribeOptions,
} from "./createMediaSubscriber";

// コーデック型
export type { AudioCodecType, VideoCodecType } from "./codec/types";

// VideoFrame ソース (MediaStreamTrackProcessor フォールバック)
export {
  createVideoFrameSource,
  isMediaStreamTrackProcessorAvailable,
  type VideoFrameSource,
} from "./frameSource";

// MOQT 拡張の再エクスポート (draft-ietf-moq-transport-21 Section 10 (MOQT Properties))
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
