/**
 * moqt-js
 *
 * MOQT (Media over QUIC Transport) client library
 * draft-ietf-moq-transport-19
 */

import { type Session, type ConnectCallbacks, type ConnectOptions, SessionImpl } from "./session";
import { normalizeMoqtUri } from "./moqtUri";

// MOQT URI / Fragment Identifier (draft-ietf-moq-transport-19 §3.1.1 / §3.1.2)
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
  JoiningFetchOptions,
  FetchCallbacks,
  FetchOptions,
  TrackStatusResult,
  NamespaceSubscriptionCallbacks,
  NamespaceSubscription,
  TracksSubscriptionCallbacks,
  TracksSubscription,
  MoqtObject,
} from "./session";
export { toHttpVersionLabel, type HttpVersionLabel } from "./httpVersion";

// Pending Subgroup Buffer オプションの再エクスポート (draft-ietf-moq-transport-19 §11.4.2)
export {
  type PendingSubgroupBufferOptions,
  DEFAULT_PENDING_SUBGROUP_BUFFER_OPTIONS,
} from "./pendingSubgroupBuffer";

// メッセージ型の再エクスポート
export type { LocationFilter, Location, Parameter } from "./message";

// Authorization Token の再エクスポート (draft-ietf-moq-transport-19 Section 10.2.2)
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
export * as LOC from "./loc";

// MSF の再エクスポート (draft-ietf-moq-msf)
export * from "./msf";

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

// MOQT 拡張の再エクスポート (draft-ietf-moq-transport-19 Section 12 (MOQT Properties))
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
  hasContainsEndOfGroup,
  hasPropertiesPresent,
  // Object Fields
  type DecodedObjectFields,
  encodeObjectFields,
  decodeObjectFields,
  // MoqtObject
  type MoqtObject as DataStreamObject,
  createObject,
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

/**
 * Connect to a MOQT server
 *
 * @param url - MOQT URI (例: `moqt://example.com/moqt`)
 * @param init - Connection options
 * @returns Session object
 *
 * @example
 * ```typescript
 * import { connect } from "moqt-js"
 *
 * const session = await connect(
 *   "moqt://example.com/moqt",
 *   { close: (info) => console.log(`disconnected: closeCode=${info.closeCode}, reason=${info.reason}`), error: (e) => console.error(e) }
 * )
 *
 * // Publish
 * const publisher = await session.publish(
 *   ["room", "123"],
 *   "video",
 *   { error: (e) => console.error(e) }
 * )
 * publisher.sendObject({ groupId: 0, objectId: 0, payload })
 *
 * // Subscribe
 * const subscriber = await session.subscribe(
 *   ["room", "123"],
 *   "video",
 *   { object: (obj) => console.log(obj), end: () => console.log("track ended"), error: (e) => console.error(e) }
 * )
 * ```
 */
export async function connect(
  url: string,
  callbacks?: ConnectCallbacks,
  options?: ConnectOptions,
): Promise<Session> {
  const { url: httpsUrl, fragment } = normalizeMoqtUri(url);

  // Create WebTransport connection
  const transportOptions: WebTransportOptions = {};

  if (options?.serverCertificateHashes && options.serverCertificateHashes.length > 0) {
    transportOptions.serverCertificateHashes = options.serverCertificateHashes;
  }

  const transport = new WebTransport(httpsUrl, transportOptions);
  await transport.ready;

  // Create session
  const session = new SessionImpl(transport, callbacks ?? {}, {
    pendingSubgroup: options?.pendingSubgroup,
    fragment,
  });

  // MOQT セッションを初期化する (SETUP メッセージの交換)
  // authorizationToken は SETUP Option (0x03) として送出する
  // draft-ietf-moq-transport-19 Section 10.3.1.4 (AUTHORIZATION TOKEN Setup Option)
  await session.initialize({
    authorizationToken: options?.authorizationToken,
    moqtImplementation: options?.moqtImplementation,
    grease: options?.grease,
  });

  return session;
}
