/**
 * MOQT Data Stream
 * draft-ietf-moq-transport-22 Section 11 (Data Streams and Datagrams)
 *
 * Data streams carry Objects via Subgroups or Datagrams.
 *
 * draft-ietf-moq-transport-22 §2.1:
 * Group または Track の中で Subgroup と Datagram の両方を使える。混在できるのは
 * Object 単位であり、同じ Object を両方の方式で送ることはできない。
 *
 * Subgroup / Datagram / Fetch が 1 モジュールに同居して見通しが悪かったため、
 * 機能単位のモジュールに分割した。本モジュールは既存の import パス
 * (`./dataStream`) を維持するための再輸出のみを行う (公開 API は変えない)。
 *
 * - ./dataStream/common: Subgroup / Datagram / Fetch で共通の型と検証
 * - ./dataStream/subgroup: Subgroup Header (Section 11.3.1) と Object fields
 * - ./dataStream/datagram: Object Datagram (Section 11.2.1)
 * - ./dataStream/fetch: Fetch Header と Fetch Object fields (Section 11.4.1)
 *
 * Uint8Array の連結は ./bytes の concatUint8Arrays に集約する。
 */

// Subgroup / Datagram / Fetch で共通の型と検証
export { type MoqtObject, validatePublisherPriority } from "./dataStream/common";

// Subgroup (Section 11.3)
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
} from "./dataStream/subgroup";

// Object Datagram (Section 11.2)
export {
  DatagramType,
  type ObjectDatagram,
  encodeObjectDatagram,
  decodeDatagramTypeAndTrackAlias,
  decodeObjectDatagram,
} from "./dataStream/datagram";

// Fetch (Section 11.4)
export {
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
} from "./dataStream/fetch";
