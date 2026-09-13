/**
 * MOQT Streaming Format (MSF) の型定義とシリアライズ関数
 *
 * MSF = LOC (メディアパッケージング) + Catalog (メタデータ) + Timeline (オプション)
 *
 * 参照: draft-ietf-moq-msf-01
 *
 * 本モジュールは draft-01 全面追従。MSF はアプリケーション層であり、MOQT トランスポート層 (session)
 * を閉じる責任を持たない。検証違反時の throw は plain `Error` で、呼び出し側 (subscriber 等) が
 * `try/catch` で吸収して UI 通知する。`ProtocolViolationError` は使わない。
 *
 * 実装は機能単位に `./msf/` 配下のモジュールへ分割しており、本モジュールは公開名を再輸出する
 * facade として機能する。`./msf` からの import は分割前と同一の名前で利用できる。
 */

// 定数 (draft-ietf-moq-msf-01 §5.1.1 / §5.2.4 / §5.2.6 / §5.2.39)
export {
  CATALOG_TRACK_NAME,
  KNOWN_CIPHER_SUITES,
  MSF_KNOWN_VERSIONS,
  MSF_VERSION,
  RESERVED_TRACK_ROLES,
} from "./msf/version";
export type { CipherSuite, MsfVersion, PackagingType, TrackRole } from "./msf/version";

// Catalog / Timeline の型 (draft-ietf-moq-msf-01 §5 / §7.1 / §8.1)
export type {
  AccessibilityDescriptor,
  AuthInfo,
  Buffers,
  Catalog,
  CatalogDelta,
  CatalogDeltaOperation,
  CatalogMessage,
  CatalogTrack,
  EventTimelineEntry,
  InitDataEntry,
  MediaTimelineEntry,
  MediaTimelineTemplate,
  PublishTrack,
  RemoveTrack,
  ValidationContext,
} from "./msf/types";

// Catalog encode/decode (draft-ietf-moq-msf-01 §5.1 / §5.1.6 / §5.3)
export { decodeCatalogMessage, encodeCatalog, encodeCatalogDelta } from "./msf/catalogCodec";

// Catalog 検証 (draft-ietf-moq-msf-01 §5.1 / §5.2)
export { validateCatalog, validateCatalogTrack } from "./msf/catalogValidation";

// Catalog 差分更新の適用 (draft-ietf-moq-msf-01 §5.1.6 / §5.3)
export { applyCatalogDelta } from "./msf/catalogDelta";

// Media Timeline / Event Timeline の encode/decode (draft-ietf-moq-msf-01 §7.1 / §8.1)
export {
  decodeEventTimeline,
  decodeMediaTimeline,
  encodeEventTimeline,
  encodeMediaTimeline,
} from "./msf/timeline";

// Variable Substitution (draft-ietf-moq-msf-01 §5.4)
export { resolveCatalogVariables } from "./msf/variables";

// MSF URI fragment 解析 (draft-ietf-moq-msf-01 §11.1)
export {
  assertMsfConnectionSupported,
  getConnectionParameter,
  parseMsfFragmentValue,
} from "./msf/fragment";
export type { MsfFragmentValue } from "./msf/fragment";

// MSF URI Fragment reserved key helpers (draft-ietf-moq-msf-01 §11.1.1)
export {
  getC4mParameter,
  getLocationRanges,
  getMediatimeRanges,
  getWallclockRanges,
} from "./msf/c4m";
export type { MsfLocationRange, MsfTimeRange } from "./msf/c4m";

// トラック検索・Catalog 生成・Group 番号付け
// (draft-ietf-moq-msf-01 §5.1.7 / §5.2.13 / §6.1)
export {
  createCatalog,
  createCompleteCatalog,
  createInitialGroupId,
  getAudioTracks,
  getTrackByName,
  getTracksByAltGroup,
  getTracksByRenderGroup,
  getVideoTracks,
  nextGroupId,
  resolveInitData,
  selectHighestBitrateTrack,
  selectLowestBitrateTrack,
  selectTrackByMaxBitrate,
  selectTrackByMaxResolution,
} from "./msf/tracks";
