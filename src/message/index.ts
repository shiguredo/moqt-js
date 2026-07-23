/**
 * MOQT Message Module
 * draft-ietf-moq-transport-19 Section 10 (Control Messages)
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
  type LocationFilter,
  type FilterRange,
  type RangeFilterParam,
  type RangeFilterRemove,
  type RangeFilterSpec,
  type TrackNamespace,
  MAX_REASON_PHRASE_LENGTH,
  MAX_TRACK_NAME_SIZE,
  MAX_TRACK_NAMESPACE_FIELDS,
  MAX_TRACK_NAMESPACE_SIZE,
  RESERVED_NAMESPACE_PREFIX,
  SESSION_LEVEL_NAMESPACE,
  createTrackNamespace,
  decodeLocation,
  decodeParameter,
  decodeKeyValuePairs,
  decodeParameters,
  decodeLocationFilter,
  decodeLocationFilterParameter,
  decodeRangeFilter,
  decodeTrackNamespace,
  encodeLocation,
  encodeParameter,
  encodeKeyValuePairs,
  encodeParameters,
  encodeParameterTrackNamespace,
  encodeLocationFilter,
  encodeLocationFilterParameter,
  encodeRangeFilter,
  encodeTrackName,
  encodeTrackNamespace,
  encodeUint8ParameterValue,
  getParameterLocationValue,
  getParameterTrackNamespace,
  getParameterVarintValue,
  isReservedNamespace,
  isSessionLevelNamespace,
  validateForwardValue,
  validateGroupOrderValue,
  trackNamespaceToStrings,
  validateTrackNameSize,
  validateFullTrackName,
} from "./parameter";

// Setup メッセージ
export {
  type Setup,
  createSetup,
  decodeSetupPayload,
  encodeSetupPayload,
  getSetupAuthority,
  getSetupAuthorizationTokens,
  getSetupMaxAuthTokenCacheSize,
  getSetupMaxFilterRanges,
  getSetupMaxRequestUpdates,
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
  decodePublishDonePayload,
  decodePublishPayload,
  encodePublishDonePayload,
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
  type PublishSkipped,
  type SubscribeNamespace,
  type SubscribeTracks,
  decodeNamespaceDonePayload,
  decodeNamespacePayload,
  decodePublishSkippedPayload,
  decodePublishNamespacePayload,
  decodeSubscribeNamespacePayload,
  decodeSubscribeTracksPayload,
  encodeNamespaceDonePayload,
  encodeNamespacePayload,
  encodePublishSkippedPayload,
  encodePublishNamespacePayload,
  encodeSubscribeNamespacePayload,
  encodeSubscribeTracksPayload,
} from "./namespace";
