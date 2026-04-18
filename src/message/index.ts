/**
 * MOQT Message Module
 * draft-ietf-moq-transport-17 Section 9 (Control Messages)
 */

// Types
export {
  FilterType,
  GroupOrder,
  type Location,
  MessageParameterType,
  MessageType,
  NamespaceSubscribeMode,
  ObjectStatus,
  PublishDoneStatusCode,
  isPublishDoneErrorStatus,
  SetupOptionType,
  VersionSpecificParameterType,
} from "./types";

// Debug
export { getMessageTypeName } from "./debug";

// Parameter
export {
  type Parameter,
  type SubscriptionFilter,
  type TrackNamespace,
  MAX_REASON_PHRASE_LENGTH,
  MAX_TRACK_NAME_SIZE,
  MAX_TRACK_NAMESPACE_FIELDS,
  MAX_TRACK_NAMESPACE_SIZE,
  createTrackNamespace,
  decodeLocation,
  decodeParameter,
  decodeKeyValuePairs,
  decodeParameters,
  decodeSubscriptionFilter,
  decodeSubscriptionFilterParameter,
  decodeTrackNamespace,
  encodeLocation,
  encodeParameter,
  encodeKeyValuePairs,
  encodeParameters,
  encodeSubscriptionFilter,
  encodeSubscriptionFilterParameter,
  encodeTrackName,
  encodeTrackNamespace,
  getParameterLocationValue,
  getParameterVarintValue,
  validateForwardValue,
  validateGroupOrderValue,
  trackNamespaceToStrings,
  validateTrackNameSize,
} from "./parameter";

// Setup Messages
export {
  type Setup,
  createSetup,
  decodeSetupPayload,
  encodeSetupPayload,
  getSetupAuthority,
  getSetupMoqtImplementation,
  getSetupParameter,
  getSetupPath,
} from "./setup";

// Subscribe Messages
export {
  type Subscribe,
  type SubscribeOk,
  type RequestUpdate,
  decodeSubscribeOkPayload,
  decodeSubscribePayload,
  decodeRequestUpdatePayload,
  encodeSubscribeOkPayload,
  encodeSubscribePayload,
  encodeRequestUpdatePayload,
} from "./subscribe";

// Publish Messages
export {
  type Publish,
  type PublishDone,
  type PublishOk,
  decodePublishDonePayload,
  decodePublishOkPayload,
  decodePublishPayload,
  encodePublishDonePayload,
  encodePublishOkPayload,
  encodePublishPayload,
} from "./publish";

// Session Messages
export {
  type Goaway,
  type RequestError,
  type RequestOk,
  decodeGoawayPayload,
  decodeRequestErrorPayload,
  decodeRequestOkPayload,
  encodeGoawayPayload,
  encodeRequestErrorPayload,
  encodeRequestOkPayload,
} from "./session";

// Fetch Messages
export {
  type Fetch,
  type FetchOk,
  type JoiningFetch,
  type StandaloneFetch,
  FetchType,
  decodeFetchOkPayload,
  decodeFetchPayload,
  encodeFetchOkPayload,
  encodeFetchPayload,
} from "./fetch";

// Track Status Messages
export {
  type TrackStatus,
  decodeTrackStatusPayload,
  encodeTrackStatusPayload,
} from "./trackstatus";

// Namespace Messages
export {
  type Namespace,
  type NamespaceDone,
  type PublishNamespace,
  type PublishBlocked,
  type SubscribeNamespace,
  decodeNamespaceDonePayload,
  decodeNamespacePayload,
  decodePublishBlockedPayload,
  decodePublishNamespacePayload,
  decodeSubscribeNamespacePayload,
  encodeNamespaceDonePayload,
  encodeNamespacePayload,
  encodePublishBlockedPayload,
  encodePublishNamespacePayload,
  encodeSubscribeNamespacePayload,
} from "./namespace";

// Control Message Union
export type { ControlMessage } from "./control";

// AUTHORIZATION_TOKEN Token 構造
export {
  type AuthToken,
  type AuthTokenDelete,
  type AuthTokenRegister,
  type AuthTokenUseAlias,
  type AuthTokenUseValue,
  AuthTokenAliasType,
  decodeAuthToken,
  encodeAuthToken,
} from "./authToken";
