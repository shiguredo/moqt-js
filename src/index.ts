/**
 * moqt-js
 *
 * MOQT (Media over QUIC Transport) client library
 * draft-ietf-moq-transport-17
 */

import { type Session, type ConnectCallbacks, type ConnectOptions, SessionImpl } from "./session";

// Re-export public types
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
  JoiningFetchOptions,
  FetchCallbacks,
  FetchOptions,
  TrackStatusResult,
  NamespaceSubscriptionCallbacks,
  NamespaceSubscription,
  MoqtObject,
} from "./session";
export { toHttpVersionLabel, type HttpVersionLabel } from "./httpVersion";

// Re-export message types
export type { SubscriptionFilter, Location, Parameter } from "./message";

// Re-export Authorization Token (draft-ietf-moq-transport-17 Section 9.3.2)
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

// Re-export error types
export { MoqtError, SessionError, RequestError, SessionErrorCode, RequestErrorCode } from "./error";

// Re-export GREASE (draft-ietf-moq-transport-17 Section 13 (Grease))
export { isGreaseValue, generateGreaseValue } from "./grease";

// Re-export LOC (draft-ietf-moq-loc)
export * as LOC from "./loc";

// Re-export MSF (draft-ietf-moq-msf)
export * from "./msf";

// Version
export { version, MOQT_IMPLEMENTATION_VALUE } from "./version";

// High-level MediaStream API
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

// Codec types
export type { AudioCodecType, VideoCodecType } from "./codec/types";

// VideoFrame ソース (MediaStreamTrackProcessor フォールバック)
export {
  createVideoFrameSource,
  isMediaStreamTrackProcessorAvailable,
  type VideoFrameSource,
} from "./frameSource";

// Re-export MOQT Extensions (draft-ietf-moq-transport-17 Section 11 (MOQT Properties))
export {
  MOQTPropertyId,
  TrackPropertyId,
  PropertyTypeRange,
  type Property,
  type PriorGroupIdGap,
  type PriorObjectIdGap,
  type ImmutableProperties,
  type ParsedProperties,
  encodeProperty,
  encodeProperties,
  encodePriorGroupIdGap,
  decodePriorGroupIdGap,
  encodePriorObjectIdGap,
  decodePriorObjectIdGap,
  encodeImmutableProperties,
  decodeImmutableProperties,
  parseProperties,
  calculateSkippedGroups,
  calculateSkippedObjects,
} from "./properties";

// Re-export Data Stream types and functions
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
  encodeFetchHeader,
  decodeFetchHeader,
  // Fetch Object Fields
  FetchSerializationFlags,
  type EndOfRangeType,
  type FetchObjectFields,
  type DecodedFetchObject,
  type FetchObjectContext,
  encodeFetchObjectFields,
  decodeFetchObjectFields,
  createFirstFetchObjectFlags,
  createFetchObjectFlags,
} from "./dataStream";

/**
 * Connect to a MOQT server
 *
 * @param url - WebTransport URL (e.g., "https://example.com/moqt")
 * @param init - Connection options
 * @returns Session object
 *
 * @example
 * ```typescript
 * import { connect } from "moqt-js"
 *
 * const session = await connect(
 *   "https://example.com/moqt",
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
  // Create WebTransport connection
  const transportOptions: WebTransportOptions = {};

  if (options?.serverCertificateHashes && options.serverCertificateHashes.length > 0) {
    transportOptions.serverCertificateHashes = options.serverCertificateHashes;
  }

  const transport = new WebTransport(url, transportOptions);
  await transport.ready;

  // Create session
  const session = new SessionImpl(transport, callbacks ?? {});

  // MOQT セッションを初期化する (SETUP メッセージの交換)
  // authorizationToken は SETUP Option (0x03) として送出する
  // draft-ietf-moq-transport-17 Section 9.4.1.4 (AUTHORIZATION TOKEN Setup Option)
  await session.initialize({
    authorizationToken: options?.authorizationToken,
  });

  return session;
}
