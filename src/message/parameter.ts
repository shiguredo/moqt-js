/**
 * MOQT Parameter encoding/decoding
 * draft-ietf-moq-transport-21 Section 9.20 (Message Parameter)
 *
 * https://datatracker.ietf.org/doc/draft-ietf-moq-transport/
 *
 * Message Parameter {
 *   Type Delta (vi64),
 *   Value (..)
 * }
 *
 * draft-ietf-moq-transport-21 §9.20 (Control Message Parameters):
 * Type Delta は前のパラメータの Type との差分で、パラメータは Type の昇順に
 * 並べる。Value のエンコーディングは各パラメータの定義が個別に定める
 * ("The encoding is specified by each parameter definition.")。MESSAGE_PARAMETER_VALUE_ENCODING
 * (./parameter/messageParameter) が型ごとのエンコーディングを持つ。
 *
 * 「偶数型: varint 値 / 奇数型: Length プレフィックス付きバイト列」という規則は
 * §8.3 (Key-Value-Pair Structure) のものであり、Message Parameter には適用されない。
 * Key-Value-Pair を扱う ./parameter/kvp の encodeKeyValuePair / decodeKeyValuePair /
 * encodeKeyValuePairs / decodeKeyValuePairs が従う。
 *
 * Key-Value-Pair (§8.3) / Message Parameter (§9.20) / Location Filter (§9.20.10) /
 * Range Filter (§3.3.2) / Track Namespace (§8.7) が 1 モジュールに同居して
 * 見通しが悪かったため、機能単位のモジュールに分割した。本モジュールは既存の
 * import パス (`./parameter`) を維持するための再輸出のみを行う (公開 API は
 * 変えない)。
 *
 * - ./parameter/common: Parameter 表現と共通の上限値
 * - ./parameter/kvp: Key-Value-Pair (§8.3)
 * - ./parameter/messageParameter: Message Parameter (§9.20)
 * - ./parameter/locationFilter: Location Filter (§9.20.10)
 * - ./parameter/rangeFilter: Range Filter (§3.3.2 / §8.6)
 * - ./parameter/trackNamespace: Track Namespace / Track Name (§8.7)
 */

// 共通の型と上限値
export { type Parameter, MAX_REASON_PHRASE_LENGTH } from "./parameter/common";

// Key-Value-Pair (§8.3)
export { encodeKeyValuePairs, decodeKeyValuePairs } from "./parameter/kvp";

// Track Namespace / Track Name (§8.7)
export {
  MAX_TRACK_NAMESPACE_SIZE,
  MAX_TRACK_NAME_SIZE,
  MAX_FULL_TRACK_NAME_SIZE,
  MAX_TRACK_NAMESPACE_FIELDS,
  type TrackNamespace,
  validateFullTrackName,
  validateFullTrackNameBytes,
  encodeTrackNamespace,
  decodeTrackNamespace,
  createTrackNamespace,
  trackNamespaceToStrings,
  isRejectedReceiveNamespace,
  encodeTrackName,
  encodeParameterTrackNamespace,
} from "./parameter/trackNamespace";

// Message Parameter (§9.20)
export {
  getParameterLocationValue,
  validateGroupOrderValue,
  validateForwardValue,
  validateIncludePropertiesValue,
  encodeUint8ParameterValue,
  encodeLocation,
  decodeLocation,
  decodeMessageParameter,
  encodeParameters,
  decodeParameters,
  isRepeatableMessageParameterType,
  assertNoDuplicateMessageParameterTypes,
  FILL_PARAMETERS_ALLOWED_TYPES,
  encodeFillParameters,
  decodeFillParameters,
} from "./parameter/messageParameter";

// Location Filter (§9.20.10)
export {
  type LocationFilter,
  isNextObjectLocationFilter,
  isSameLocationFilter,
  encodeLocationFilter,
  decodeLocationFilter,
  encodeLocationFilterParameter,
  decodeLocationFilterParameter,
} from "./parameter/locationFilter";

// Range Filter (§3.3.2 / §8.6)
export {
  type FilterRange,
  type RangeFilterParam,
  type RangeFilterRemove,
  type RangeFilterSpec,
  encodeRangeFilter,
  decodeRangeFilter,
  validateRangeFilterCombination,
  rangeFilterTypeOf,
} from "./parameter/rangeFilter";
