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
  encodeFetchPayload,
} from "./fetch";

// Track Status Messages
export {
  type TrackStatus,
  decodeTrackStatusPayload,
  encodeTrackStatusPayload,
} from "./trackstatus";

// Control Message Union
export type { ControlMessage } from "./control";

// AUTHORIZATION_TOKEN Token 構造
export {
  type AuthorizationToken,
  type AuthorizationTokenDelete,
  type AuthorizationTokenRegister,
  type AuthorizationTokenUseAlias,
  type AuthorizationTokenUseValue,
  AuthorizationTokenAliasType,
  decodeAuthorizationToken,
  encodeAuthorizationToken,
} from "./authorizationToken";
