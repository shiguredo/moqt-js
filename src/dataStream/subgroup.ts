/**
 * MOQT Subgroup Stream
 * draft-ietf-moq-transport-21 Section 11.3 (Subgroup Streams)
 *
 * Subgroup Header (Section 11.3.1) と、その配下に並ぶ Object fields
 * (Figure 25: Object ID Delta / Properties / Object Payload Length /
 * Object Status / Object Payload) のエンコードとデコードを扱う。
 */

import { decodeVarint, encodeVarint } from "../varint";
import { ObjectStatus } from "../message/types";
import { IncompleteDataError, ProtocolViolationError } from "../error";
import {
  assertKnownPropertyValueInObjectProperties,
  assertNoMandatoryTrackPropertyInObjectProperties,
} from "../properties";
import { concatUint8Arrays } from "../bytes";
import {
  ERR_PUBLISHER_PRIORITY_REQUIRED,
  validateObjectStatus,
  validatePublisherPriority,
} from "./common";

/**
 * Subgroup Header Type Flags (Section 11.3.1)
 *
 * draft-ietf-moq-transport-21 Section 11.3.1 (Appendix A.2 #1774 で
 * Type Flags bitfield として記述):
 * Type Flags はフラグ集合を表す可変長整数であり、定義値は 1 バイト
 * (128 未満) に収まる。bit 4 は常に 1 であり、下位 4 ビットと bit 5-6 が
 * フィールドの有無を決める (PROPERTIES 0x01 / SUBGROUP_ID_MODE bit 1-2 /
 * END_OF_GROUP 0x08 / DEFAULT_PRIORITY 0x20 / FIRST_OBJECT 0x40)。
 * SUBGROUP_ID_MODE 0b11 や bit 4 未設定など、意味の無いビットが立つ値は
 * PROTOCOL_VIOLATION で拒否する。
 *
 * Type values 0x10-0x1D (Priority Present = Yes)
 * Type values 0x30-0x3D (Priority Present = No)
 *
 * Section 11.3.1 (Subgroup Header) type matrix from draft-ietf-moq-transport-21:
 * | Type | Subgroup ID Field | Subgroup ID Value | Properties | End of Group | Priority |
 * |------|-------------------|-------------------|------------|--------------|----------|
 * | 0x10 | No                | 0                 | No         | No           | Yes      |
 * | 0x11 | No                | 0                 | Yes        | No           | Yes      |
 * | 0x12 | No                | First Object ID   | No         | No           | Yes      |
 * | 0x13 | No                | First Object ID   | Yes        | No           | Yes      |
 * | 0x14 | Yes               | N/A               | No         | No           | Yes      |
 * | 0x15 | Yes               | N/A               | Yes        | No           | Yes      |
 * | 0x18 | No                | 0                 | No         | Yes          | Yes      |
 * | 0x19 | No                | 0                 | Yes        | Yes          | Yes      |
 * | 0x1A | No                | First Object ID   | No         | Yes          | Yes      |
 * | 0x1B | No                | First Object ID   | Yes        | Yes          | Yes      |
 * | 0x1C | Yes               | N/A               | No         | Yes          | Yes      |
 * | 0x1D | Yes               | N/A               | Yes        | Yes          | Yes      |
 * | 0x30 | No                | 0                 | No         | No           | No       |
 * | 0x31 | No                | 0                 | Yes        | No           | No       |
 * | 0x32 | No                | First Object ID   | No         | No           | No       |
 * | 0x33 | No                | First Object ID   | Yes        | No           | No       |
 * | 0x34 | Yes               | N/A               | No         | No           | No       |
 * | 0x35 | Yes               | N/A               | Yes        | No           | No       |
 * | 0x38 | No                | 0                 | No         | Yes          | No       |
 * | 0x39 | No                | 0                 | Yes        | Yes          | No       |
 * | 0x3A | No                | First Object ID   | No         | Yes          | No       |
 * | 0x3B | No                | First Object ID   | Yes        | Yes          | No       |
 * | 0x3C | Yes               | N/A               | No         | Yes          | No       |
 * | 0x3D | Yes               | N/A               | Yes        | Yes          | No       |
 * | 0x50 | No                | 0                 | No         | No           | Yes      |
 * | 0x51 | No                | 0                 | Yes        | No           | Yes      |
 * | 0x52 | No                | First Object ID   | No         | No           | Yes      |
 * | 0x53 | No                | First Object ID   | Yes        | No           | Yes      |
 * | 0x54 | Yes               | N/A               | No         | No           | Yes      |
 * | 0x55 | Yes               | N/A               | Yes        | No           | Yes      |
 * | 0x58 | No                | 0                 | No         | Yes          | Yes      |
 * | 0x59 | No                | 0                 | Yes        | Yes          | Yes      |
 * | 0x5A | No                | First Object ID   | No         | Yes          | Yes      |
 * | 0x5B | No                | First Object ID   | Yes        | Yes          | Yes      |
 * | 0x5C | Yes               | N/A               | No         | Yes          | Yes      |
 * | 0x5D | Yes               | N/A               | Yes        | Yes          | Yes      |
 * | 0x70 | No                | 0                 | No         | No           | No       |
 * | 0x71 | No                | 0                 | Yes        | No           | No       |
 * | 0x72 | No                | First Object ID   | No         | No           | No       |
 * | 0x73 | No                | First Object ID   | Yes        | No           | No       |
 * | 0x74 | Yes               | N/A               | No         | No           | No       |
 * | 0x75 | Yes               | N/A               | Yes        | No           | No       |
 * | 0x78 | No                | 0                 | No         | Yes          | No       |
 * | 0x79 | No                | 0                 | Yes        | Yes          | No       |
 * | 0x7A | No                | First Object ID   | No         | Yes          | No       |
 * | 0x7B | No                | First Object ID   | Yes        | Yes          | No       |
 * | 0x7C | Yes               | N/A               | No         | Yes          | No       |
 * | 0x7D | Yes               | N/A               | Yes        | Yes          | No       |
 *
 * FIRST_OBJECT bit (0x40): Type 0x50-0x5D and 0x70-0x7D have the
 * FIRST_OBJECT bit set, indicating the first object in the subgroup stream
 * is the first object ever published in that subgroup.
 */
export const SubgroupHeaderType = {
  // Priority Present = Yes, Contains End of Group = No
  // Subgroup ID = 0, No Properties (Section 11.3.1: Type 0x10)
  BASE: 0x10,
  // Subgroup ID = 0, Properties Present (Section 11.3.1: Type 0x11)
  BASE_EXT: 0x11,
  // Subgroup ID = First Object ID, No Properties (Section 11.3.1: Type 0x12)
  FIRST_OBJ: 0x12,
  // Subgroup ID = First Object ID, Properties Present (Section 11.3.1: Type 0x13)
  FIRST_OBJ_EXT: 0x13,
  // Subgroup ID Field Present, No Properties (Section 11.3.1: Type 0x14)
  EXPLICIT: 0x14,
  // Subgroup ID Field Present, Properties Present (Section 11.3.1: Type 0x15)
  EXPLICIT_EXT: 0x15,

  // Priority Present = Yes, Contains End of Group = Yes
  // Subgroup ID = 0, No Properties (Section 11.3.1: Type 0x18)
  BASE_END_GROUP: 0x18,
  // Subgroup ID = 0, Properties Present (Section 11.3.1: Type 0x19)
  BASE_EXT_END_GROUP: 0x19,
  // Subgroup ID = First Object ID, No Properties (Section 11.3.1: Type 0x1A)
  FIRST_OBJ_END_GROUP: 0x1a,
  // Subgroup ID = First Object ID, Properties Present (Section 11.3.1: Type 0x1B)
  FIRST_OBJ_EXT_END_GROUP: 0x1b,
  // Subgroup ID Field Present, No Properties (Section 11.3.1: Type 0x1C)
  EXPLICIT_END_GROUP: 0x1c,
  // Subgroup ID Field Present, Properties Present (Section 11.3.1: Type 0x1D)
  EXPLICIT_EXT_END_GROUP: 0x1d,

  // Priority Present = No, Contains End of Group = No
  // Subgroup ID = 0, No Properties (Section 11.3.1: Type 0x30)
  BASE_NO_PRIORITY: 0x30,
  // Subgroup ID = 0, Properties Present (Section 11.3.1: Type 0x31)
  BASE_EXT_NO_PRIORITY: 0x31,
  // Subgroup ID = First Object ID, No Properties (Section 11.3.1: Type 0x32)
  FIRST_OBJ_NO_PRIORITY: 0x32,
  // Subgroup ID = First Object ID, Properties Present (Section 11.3.1: Type 0x33)
  FIRST_OBJ_EXT_NO_PRIORITY: 0x33,
  // Subgroup ID Field Present, No Properties (Section 11.3.1: Type 0x34)
  EXPLICIT_NO_PRIORITY: 0x34,
  // Subgroup ID Field Present, Properties Present (Section 11.3.1: Type 0x35)
  EXPLICIT_EXT_NO_PRIORITY: 0x35,

  // Priority Present = No, Contains End of Group = Yes
  // Subgroup ID = 0, No Properties (Section 11.3.1: Type 0x38)
  BASE_END_GROUP_NO_PRIORITY: 0x38,
  // Subgroup ID = 0, Properties Present (Section 11.3.1: Type 0x39)
  BASE_EXT_END_GROUP_NO_PRIORITY: 0x39,
  // Subgroup ID = First Object ID, No Properties (Section 11.3.1: Type 0x3A)
  FIRST_OBJ_END_GROUP_NO_PRIORITY: 0x3a,
  // Subgroup ID = First Object ID, Properties Present (Section 11.3.1: Type 0x3B)
  FIRST_OBJ_EXT_END_GROUP_NO_PRIORITY: 0x3b,
  // Subgroup ID Field Present, No Properties (Section 11.3.1: Type 0x3C)
  EXPLICIT_END_GROUP_NO_PRIORITY: 0x3c,
  // Subgroup ID Field Present, Properties Present (Section 11.3.1: Type 0x3D)
  EXPLICIT_EXT_END_GROUP_NO_PRIORITY: 0x3d,

  // FIRST_OBJECT bit (0x40) セット: Priority Present = Yes, Contains End of Group = No
  BASE_FIRST: 0x50,
  BASE_EXT_FIRST: 0x51,
  FIRST_OBJ_FIRST: 0x52,
  FIRST_OBJ_EXT_FIRST: 0x53,
  EXPLICIT_FIRST: 0x54,
  EXPLICIT_EXT_FIRST: 0x55,

  // FIRST_OBJECT: Priority Present = Yes, Contains End of Group = Yes
  BASE_END_GROUP_FIRST: 0x58,
  BASE_EXT_END_GROUP_FIRST: 0x59,
  FIRST_OBJ_END_GROUP_FIRST: 0x5a,
  FIRST_OBJ_EXT_END_GROUP_FIRST: 0x5b,
  EXPLICIT_END_GROUP_FIRST: 0x5c,
  EXPLICIT_EXT_END_GROUP_FIRST: 0x5d,

  // FIRST_OBJECT: Priority Present = No, Contains End of Group = No
  BASE_NO_PRIORITY_FIRST: 0x70,
  BASE_EXT_NO_PRIORITY_FIRST: 0x71,
  FIRST_OBJ_NO_PRIORITY_FIRST: 0x72,
  FIRST_OBJ_EXT_NO_PRIORITY_FIRST: 0x73,
  EXPLICIT_NO_PRIORITY_FIRST: 0x74,
  EXPLICIT_EXT_NO_PRIORITY_FIRST: 0x75,

  // FIRST_OBJECT: Priority Present = No, Contains End of Group = Yes
  BASE_END_GROUP_NO_PRIORITY_FIRST: 0x78,
  BASE_EXT_END_GROUP_NO_PRIORITY_FIRST: 0x79,
  FIRST_OBJ_END_GROUP_NO_PRIORITY_FIRST: 0x7a,
  FIRST_OBJ_EXT_END_GROUP_NO_PRIORITY_FIRST: 0x7b,
  EXPLICIT_END_GROUP_NO_PRIORITY_FIRST: 0x7c,
  EXPLICIT_EXT_END_GROUP_NO_PRIORITY_FIRST: 0x7d,
} as const;

/**
 * Subgroup Header
 */
export interface SubgroupHeader {
  type: number;
  trackAlias: bigint;
  groupId: bigint;
  subgroupId?: bigint;
  publisherPriority?: number;
  /**
   * FIRST_OBJECT bit (0x40) がセットされている場合に true。
   * Subgroup 内の最初のオブジェクトが、その Subgroup で最初に publish された
   * オブジェクトであることを示す。
   * draft-ietf-moq-transport-21 Section 11.3.1
   */
  firstObject?: boolean;
  /**
   * END_OF_GROUP bit (0x08) がセットされている場合に true。
   *
   * draft-ietf-moq-transport-21 §11.3.1:
   * "The END_OF_GROUP bit (0x08) indicates that this subgroup contains the
   *  largest Object in the Group. When set to 1, the subscriber can infer the
   *  final Object in the Group when the data stream is terminated by a FIN."
   * 受信側はこのビットとストリームの FIN から Group の最終 Object を推定できる。
   * Object Status が END_OF_GROUP の Object も Group の最終 Object を明示する
   * (§11.1.2)。
   */
  endOfGroup?: boolean;
}

/**
 * Check if subgroup header type has explicit Subgroup ID field
 * draft-ietf-moq-transport-21 Section 11.3.1
 */
function hasSubgroupIdField(headerType: number): boolean {
  const lowNibble = headerType & 0x0f;
  return lowNibble === 0x04 || lowNibble === 0x05 || lowNibble === 0x0c || lowNibble === 0x0d;
}

/**
 * Check if subgroup header type has Priority Present
 * draft-ietf-moq-transport-21 Section 11.3.1
 *
 * Types 0x10-0x1D have Priority Present = Yes
 * Types 0x30-0x3D have Priority Present = No
 */
function hasPriorityPresent(headerType: number): boolean {
  // FIRST_OBJECT bit (0x40) をマスクして判定
  // 0x50-0x5D も Priority Present = Yes
  const normalizedType = headerType & 0x3f;
  return normalizedType >= 0x10 && normalizedType <= 0x1d;
}

/**
 * Check if subgroup header type contains End of Group
 * draft-ietf-moq-transport-21 Section 11.3.1
 *
 * Types with bit 3 set (0x08) contain End of Group:
 * 0x18-0x1D (Priority Present) and 0x38-0x3D (No Priority)
 */
export function hasEndOfGroup(headerType: number): boolean {
  const lowNibble = headerType & 0x0f;
  return lowNibble >= 0x08 && lowNibble <= 0x0d;
}

/**
 * Encode a Subgroup Header
 * draft-ietf-moq-transport-21 Section 11.3.1 Figure 25
 */
export function encodeSubgroupHeader(header: SubgroupHeader): Uint8Array {
  const parts: Uint8Array[] = [];

  // FIRST_OBJECT bit (0x40) / END_OF_GROUP bit (0x08) がセットされている場合、
  // Type に OR する。両ビットはフィールドの有無 (Subgroup ID / Priority /
  // Properties) を決めるビットではないため、後続の判定は header.type のままで
  // 結果が変わらない (0x08 は bit 3、0x40 は bit 6)。
  let type = header.firstObject ? header.type | 0x40 : header.type;
  if (header.endOfGroup) {
    type |= 0x08;
  }
  parts.push(encodeVarint(type));
  parts.push(encodeVarint(header.trackAlias));
  parts.push(encodeVarint(header.groupId));

  // Subgroup ID フィールド (明示的な Subgroup ID を持つタイプのみ)
  if (hasSubgroupIdField(header.type) && header.subgroupId !== undefined) {
    parts.push(encodeVarint(header.subgroupId));
  }

  // Publisher Priority (8 ビット) - Priority Present を持つタイプのみ
  // draft-ietf-moq-transport-21 Section 11.3.1:
  // "When set to 0, the Priority field is present in the Subgroup header."
  // Priority Present の型で省略すると、デコード側は Priority フィールドを
  // 存在確認なしに消費し、後続フィールド (Object ID Delta の先頭等) が
  // Priority として誤読される (フィールドずれ)。encodeObjectDatagram と
  // 同じ防御で throw する。判定は未 OR の header.type で行うが、
  // hasPriorityPresent が 0x3f でマスクするため firstObject (0x40) の有無は
  // 結果に影響しない (decode 側は OR 済みの値で同条件を判定する)。
  if (hasPriorityPresent(header.type)) {
    if (header.publisherPriority === undefined) {
      throw new Error(ERR_PUBLISHER_PRIORITY_REQUIRED);
    }
    validatePublisherPriority(header.publisherPriority);
    parts.push(new Uint8Array([header.publisherPriority]));
  }

  return concatUint8Arrays(parts);
}

/**
 * Decode a Subgroup Header
 */
export function decodeSubgroupHeader(data: Uint8Array, offset = 0): [SubgroupHeader, number] {
  let totalConsumed = 0;

  const [type, typeConsumed] = decodeVarint(data, offset + totalConsumed);
  totalConsumed += typeConsumed;

  const [trackAlias, trackAliasConsumed] = decodeVarint(data, offset + totalConsumed);
  totalConsumed += trackAliasConsumed;

  const [groupId, groupIdConsumed] = decodeVarint(data, offset + totalConsumed);
  totalConsumed += groupIdConsumed;

  let subgroupId: bigint | undefined;
  const typeNum = Number(type);

  // draft-ietf-moq-transport-21 Section 11.3.1:
  // 不正なタイプ値を検証する
  // "Bit 4 MUST be set to 1. Bit 7 MUST be set to 0."
  // 加えて "Values of 128 or greater ... MUST close the session with a
  // PROTOCOL_VIOLATION" のため、bit 7 だけでなく 128 以上をすべて拒否する
  // SUBGROUP_ID_MODE = 0b11 (0x16, 0x17, 0x1E, 0x1F, 0x36, 0x37, 0x3E, 0x3F,
  // 0x56, 0x57, 0x5E, 0x5F, 0x76, 0x77, 0x7E, 0x7F) は予約済み
  // 0b0XX1XXXX の形式でないタイプ値は不正
  const subgroupIdMode = (typeNum & 0x06) >> 1;
  if (subgroupIdMode === 0x03) {
    throw new ProtocolViolationError(
      `invalid subgroup header type: 0x${typeNum.toString(16)}, SUBGROUP_ID_MODE 0b11 is reserved`,
    );
  }
  if ((typeNum & 0x10) === 0 || typeNum > 0x7f) {
    throw new ProtocolViolationError(
      `invalid subgroup header type: 0x${typeNum.toString(16)}, does not match form 0b0XX1XXXX`,
    );
  }

  // タイプに基づいて Subgroup ID フィールドの有無を判定
  // draft-ietf-moq-transport-21 Section 11.3.1:
  // - Types 0x14-0x15, 0x1C-0x1D, 0x34-0x35, 0x3C-0x3D,
  //   0x54-0x55, 0x5C-0x5D, 0x74-0x75, 0x7C-0x7D: Subgroup ID Field Present
  // - Types 0x10-0x11, 0x18-0x19, 0x30-0x31, 0x38-0x39,
  //   0x50-0x51, 0x58-0x59, 0x70-0x71, 0x78-0x79: Subgroup ID = 0
  // - Types 0x12-0x13, 0x1A-0x1B, 0x32-0x33, 0x3A-0x3B,
  //   0x52-0x53, 0x5A-0x5B, 0x72-0x73, 0x7A-0x7B: Subgroup ID = First Object ID (no field)
  const lowNibble = typeNum & 0x0f;
  if (lowNibble === 0x04 || lowNibble === 0x05 || lowNibble === 0x0c || lowNibble === 0x0d) {
    // 明示的な Subgroup ID フィールドが存在
    const [sid, sidConsumed] = decodeVarint(data, offset + totalConsumed);
    subgroupId = sid;
    totalConsumed += sidConsumed;
  } else if (lowNibble === 0x00 || lowNibble === 0x01 || lowNibble === 0x08 || lowNibble === 0x09) {
    // Subgroup ID = 0
    subgroupId = 0n;
  }
  // タイプ 0x02, 0x03, 0x0A, 0x0B:
  // Subgroup ID = First Object ID (最初のオブジェクト読み取り時に設定)

  // Publisher Priority (8 ビット)
  // draft-ietf-moq-transport-21 Section 11.3.1
  let publisherPriority: number | undefined;
  if (hasPriorityPresent(typeNum)) {
    // Priority は 8 bit 固定のため、バッファが Priority バイトで切れている
    // 場合は範囲外アクセス (undefined 取得) による誤デコードを避け、
    // IncompleteDataError で次のチャンクを待つ (decodeFetchObjectFields と同方式。
    // 誤読すると残りバイト列が 1 バイトずれてフィールドずれを生む)。
    if (offset + totalConsumed >= data.length) {
      throw new IncompleteDataError("incomplete subgroup header: publisher priority");
    }
    const priorityByte = data[offset + totalConsumed];
    if (priorityByte === undefined) {
      // 上の offset + totalConsumed >= data.length の検証により到達しない
      // (noUncheckedIndexedAccess で型上 undefined を含むための防御)
      throw new IncompleteDataError("incomplete subgroup header: publisher priority");
    }
    publisherPriority = priorityByte;
    totalConsumed += 1;
  }

  // FIRST_OBJECT bit (0x40) の抽出
  const firstObject = (typeNum & 0x40) !== 0 ? true : undefined;

  // END_OF_GROUP bit (0x08) の抽出
  // draft-ietf-moq-transport-21 §11.3.1: この Subgroup が Group の最大 Object を
  // 含むことを示す。FIN と組み合わせて Group の最終 Object を推定できる。
  const endOfGroup = hasEndOfGroup(typeNum) ? true : undefined;

  return [
    {
      type: typeNum,
      trackAlias,
      groupId,
      // exactOptionalPropertyTypes では optional なフィールドに undefined を渡せないため、
      // 値がある場合だけ載せる (「未設定 = そのフィールドが wire に存在しない」を保つ)
      ...(subgroupId !== undefined ? { subgroupId } : {}),
      ...(publisherPriority !== undefined ? { publisherPriority } : {}),
      ...(firstObject !== undefined ? { firstObject } : {}),
      ...(endOfGroup !== undefined ? { endOfGroup } : {}),
    },
    totalConsumed,
  ];
}

/**
 * Check if a subgroup header type has Properties Present
 * draft-ietf-moq-transport-21 Section 11.3.1:
 * Types with bit 0 set (odd types) have Properties Present
 */
export function hasPropertiesPresent(headerType: number): boolean {
  return (headerType & 0x01) === 0x01;
}

/**
 * Encode Object fields for Subgroup stream
 * draft-ietf-moq-transport-21 Section 11.3.1 Figure 25:
 * {
 *   Object ID Delta (i),
 *   [Properties (..),]          <-- Only if header type has Properties Present
 *   Object Payload Length (i),
 *   [Object Status (i),]        <-- Only if payload length is 0
 *   [Object Payload (..),]
 * }
 *
 * @param objectIdDelta - Object ID delta from previous object (or absolute ID for first object)
 * @param payloadLength - Length of payload
 * @param headerType - Subgroup header type to determine if properties are present
 * @param status - Object status (only encoded if payload length is 0)
 * @param properties - Properties data (only encoded if header type has Properties Present)
 */
export function encodeObjectFields(
  objectIdDelta: bigint,
  payloadLength: bigint,
  headerType: number,
  status: ObjectStatus = ObjectStatus.NORMAL,
  properties?: Uint8Array,
): Uint8Array {
  const parts: Uint8Array[] = [];

  // Object ID Delta
  parts.push(encodeVarint(objectIdDelta));

  // プロパティ (ヘッダータイプが Properties Present の場合のみ)
  if (hasPropertiesPresent(headerType)) {
    const extLen = properties?.length ?? 0;

    // draft-ietf-moq-transport-21 Section 11.1.3:
    // "If an endpoint receives properties on an Object with status
    // that is not Normal, it MUST close the session with a PROTOCOL_VIOLATION."
    if (status !== ObjectStatus.NORMAL && extLen > 0) {
      throw new ProtocolViolationError("properties on non-Normal status object");
    }

    parts.push(encodeVarint(extLen));
    if (properties && properties.length > 0) {
      parts.push(properties);
    }
  }

  // ペイロード長
  parts.push(encodeVarint(payloadLength));

  // draft-ietf-moq-transport-21 §11.1.2:
  // 非 NORMAL ステータスはペイロード長が 0 の場合のみエンコードされる。
  // payloadLength > 0 の場合、ステータスは wire に乗らないため ProtocolViolationError とする
  if (status !== ObjectStatus.NORMAL && payloadLength > 0n) {
    throw new ProtocolViolationError(`non-Normal status ${status} with non-empty payload`);
  }

  // ステータス (ペイロード長が 0 の場合のみ)
  // draft-ietf-moq-transport-21 Section 11.1.2:
  // "Zero-length objects explicitly encode the Normal status."
  if (payloadLength === 0n) {
    parts.push(encodeVarint(status));
  }

  return concatUint8Arrays(parts);
}

/**
 * Decoded Object fields
 */
export interface DecodedObjectFields {
  objectIdDelta: bigint;
  propertiesLength: number;
  properties: Uint8Array;
  status: ObjectStatus;
  payloadLength: bigint;
}

/**
 * Decode Object fields from Subgroup stream
 * draft-ietf-moq-transport-21 Section 11.3.1 Figure 25
 *
 * @param data - Data buffer
 * @param headerType - Subgroup header type to determine if properties are present
 * @param offset - Starting offset in buffer
 */
export function decodeObjectFields(
  data: Uint8Array,
  headerType: number,
  offset = 0,
): [DecodedObjectFields, number] {
  let totalConsumed = 0;

  // Object ID Delta
  const [objectIdDelta, objectIdConsumed] = decodeVarint(data, offset + totalConsumed);
  totalConsumed += objectIdConsumed;

  // プロパティ (ヘッダータイプが Properties Present の場合のみ)
  let propertiesLength = 0;
  let properties = new Uint8Array(0);
  if (hasPropertiesPresent(headerType)) {
    const [extLen, extLenConsumed] = decodeVarint(data, offset + totalConsumed);
    propertiesLength = Number(extLen);
    totalConsumed += extLenConsumed;

    // Properties 本体が宣言バイト数に満たない場合は切り詰めず
    // IncompleteDataError で次のチャンクを待つ (decodeSubgroupHeader の
    // Priority バイト境界チェックと同方式。切り詰めると totalConsumed が
    // 実バイト数を超えて後続フィールドを誤読する)。
    // draft-ietf-moq-transport-21 Section 11.3.1:
    // 節番号は仕様将来版で変わる可能性がある。
    if (offset + totalConsumed + propertiesLength > data.length) {
      throw new IncompleteDataError("incomplete object fields: properties");
    }
    properties = data.slice(offset + totalConsumed, offset + totalConsumed + propertiesLength);
    totalConsumed += propertiesLength;
  }

  // ペイロード長
  const [payloadLength, payloadLenConsumed] = decodeVarint(data, offset + totalConsumed);
  totalConsumed += payloadLenConsumed;

  // ステータス (ペイロード長が 0 の場合のみ)
  // draft-ietf-moq-transport-21 Section 11.1.2:
  // "Zero-length objects explicitly encode the Normal status."
  let status: ObjectStatus = ObjectStatus.NORMAL;
  if (payloadLength === 0n) {
    const [statusVal, statusConsumed] = decodeVarint(data, offset + totalConsumed);
    status = Number(statusVal) as ObjectStatus;
    validateObjectStatus(status);
    totalConsumed += statusConsumed;

    // draft-ietf-moq-transport-21 Section 11.1.3:
    // "Any Object with status Normal can have properties (Section 8.4).
    // If an endpoint receives properties on an Object with status
    // that is not Normal, it MUST close the session with a PROTOCOL_VIOLATION."
    if (status !== ObjectStatus.NORMAL && propertiesLength > 0) {
      throw new ProtocolViolationError("properties on non-Normal status object");
    }
  }

  // draft-ietf-moq-transport-21 §3.6:
  // Mandatory Track Property を Object Property として含む Object は malformed
  // (non-Normal status の properties 検証より後に判定する)
  if (propertiesLength > 0) {
    assertNoMandatoryTrackPropertyInObjectProperties(properties);
    // draft-ietf-moq-transport-21 §8.3:
    // 既知 Type の Value が serialization に一致しない場合は
    // KEY_VALUE_FORMATTING_ERROR でセッションを閉じる
    assertKnownPropertyValueInObjectProperties(properties);
  }

  return [
    {
      objectIdDelta,
      propertiesLength,
      properties,
      status,
      payloadLength,
    },
    totalConsumed,
  ];
}
