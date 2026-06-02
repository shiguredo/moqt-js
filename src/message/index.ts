/**
 * MOQT Message Module
 * draft-ietf-moq-transport-18 Section 10 (Control Messages)
 */

// 型定義
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
} from "./types";

// デバッグ
export { getMessageTypeName, getRequestOkAliasName } from "./debug";

// パラメータ
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
  encodeUint8ParameterValue,
  encodeTrackName,
  encodeTrackNamespace,
  getParameterLocationValue,
  getParameterVarintValue,
  validateForwardValue,
  validateGroupOrderValue,
  trackNamespaceToStrings,
  validateTrackNameSize,
} from "./parameter";

// Setup メッセージ
export {
  type Setup,
  createSetup,
  decodeSetupPayload,
  encodeSetupPayload,
  getSetupAuthority,
  getSetupAuthorizationTokens,
  getSetupMoqtImplementation,
  getSetupParameter,
  getSetupPath,
} from "./setup";

// Authorization Token (Section 10.2.2)
export {
  type AuthorizationToken,
  type AuthorizationTokenDelete,
  type AuthorizationTokenRegister,
  type AuthorizationTokenUseAlias,
  type AuthorizationTokenUseValue,
  AuthorizationTokenAliasType,
  assertAuthorizationTokenForSetup,
  decodeAuthorizationToken,
  encodeAuthorizationToken,
} from "./authorizationToken";

// Subscribe メッセージ
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

// Publish メッセージ
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

// Session メッセージ
export {
  type Goaway,
  type Redirect,
  type RequestError,
  type RequestOk,
  decodeGoawayPayload,
  decodeRedirect,
  decodeRequestErrorPayload,
  decodeRequestOkPayload,
  encodeGoawayPayload,
  encodeRedirect,
  encodeRequestErrorPayload,
  encodeRequestOkPayload,
} from "./session";

// Fetch メッセージ
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

// Track Status メッセージ
export {
  type TrackStatus,
  decodeTrackStatusPayload,
  encodeTrackStatusPayload,
} from "./trackstatus";

// Namespace メッセージ
export {
  type Namespace,
  type NamespaceDone,
  type PublishNamespace,
  type PublishBlocked,
  type SubscribeNamespace,
  type SubscribeTracks,
  decodeNamespaceDonePayload,
  decodeNamespacePayload,
  decodePublishBlockedPayload,
  decodePublishNamespacePayload,
  decodeSubscribeNamespacePayload,
  decodeSubscribeTracksPayload,
  encodeNamespaceDonePayload,
  encodeNamespacePayload,
  encodePublishBlockedPayload,
  encodePublishNamespacePayload,
  encodeSubscribeNamespacePayload,
  encodeSubscribeTracksPayload,
} from "./namespace";
