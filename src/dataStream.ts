/**
 * MOQT Data Stream
 * draft-ietf-moq-transport-18 Section 11 (Data Streams and Datagrams)
 *
 * Data streams carry Objects via Subgroups or Datagrams.
 *
 * draft-ietf-moq-transport-18:
 * 同一トラック内で Datagram と Subgroup (Stream) の混在が許可される。
 * Publisher は同じトラックのオブジェクトを Datagram と Stream の両方で送信できる。
 * draft-ietf-moq-transport-18 Section 11
 */

import { decodeVarint, encodeVarint } from "./varint";
import { ObjectStatus } from "./message/types";
import { ProtocolViolationError } from "./error";
import { GroupOrder } from "./message/types";

/**
 * Object ID および Group ID の最大値 (2^64 - 1)
 * draft-ietf-moq-transport-18 §11.4.2 / §11.4.4.1 Table 9:
 * "If the resulting Object ID would be greater than 2^64 - 1,
 *  the endpoint MUST close the session with a PROTOCOL_VIOLATION."
 * "If the computed Group ID would be less than 0 or greater than 2^64-1,
 *  the Subscriber MUST close the Session with error 'PROTOCOL_VIOLATION'."
 */
const maxObjectId = (1n << 64n) - 1n;

/**
 * Object Status の値を検証する
 *
 * draft-ietf-moq-transport-18 Section 11.2.1.1:
 * "Any other value SHOULD be treated as a protocol error and the session
 *  SHOULD be closed with a PROTOCOL_VIOLATION."
 */
function validateObjectStatus(status: number): void {
  if (
    status !== ObjectStatus.NORMAL &&
    status !== ObjectStatus.END_OF_GROUP &&
    status !== ObjectStatus.END_OF_TRACK
  ) {
    throw new ProtocolViolationError(
      `invalid object status: 0x${status.toString(16)}, expected 0x0, 0x3, or 0x4`,
    );
  }
}

/**
 * Subgroup Header Type (Section 11.4.2)
 *
 * Type values 0x10-0x1D (Priority Present = Yes)
 * Type values 0x30-0x3D (Priority Present = No)
 *
 * Section 11.4.2 (Subgroup Header) type matrix from draft-ietf-moq-transport-18:
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
  // Subgroup ID = 0, No Properties (Section 11.4.2: Type 0x10)
  BASE: 0x10,
  // Subgroup ID = 0, Properties Present (Section 11.4.2: Type 0x11)
  BASE_EXT: 0x11,
  // Subgroup ID = First Object ID, No Properties (Section 11.4.2: Type 0x12)
  FIRST_OBJ: 0x12,
  // Subgroup ID = First Object ID, Properties Present (Section 11.4.2: Type 0x13)
  FIRST_OBJ_EXT: 0x13,
  // Subgroup ID Field Present, No Properties (Section 11.4.2: Type 0x14)
  EXPLICIT: 0x14,
  // Subgroup ID Field Present, Properties Present (Section 11.4.2: Type 0x15)
  EXPLICIT_EXT: 0x15,

  // Priority Present = Yes, Contains End of Group = Yes
  // Subgroup ID = 0, No Properties (Section 11.4.2: Type 0x18)
  BASE_END_GROUP: 0x18,
  // Subgroup ID = 0, Properties Present (Section 11.4.2: Type 0x19)
  BASE_EXT_END_GROUP: 0x19,
  // Subgroup ID = First Object ID, No Properties (Section 11.4.2: Type 0x1A)
  FIRST_OBJ_END_GROUP: 0x1a,
  // Subgroup ID = First Object ID, Properties Present (Section 11.4.2: Type 0x1B)
  FIRST_OBJ_EXT_END_GROUP: 0x1b,
  // Subgroup ID Field Present, No Properties (Section 11.4.2: Type 0x1C)
  EXPLICIT_END_GROUP: 0x1c,
  // Subgroup ID Field Present, Properties Present (Section 11.4.2: Type 0x1D)
  EXPLICIT_EXT_END_GROUP: 0x1d,

  // Priority Present = No, Contains End of Group = No
  // Subgroup ID = 0, No Properties (Section 11.4.2: Type 0x30)
  BASE_NO_PRIORITY: 0x30,
  // Subgroup ID = 0, Properties Present (Section 11.4.2: Type 0x31)
  BASE_EXT_NO_PRIORITY: 0x31,
  // Subgroup ID = First Object ID, No Properties (Section 11.4.2: Type 0x32)
  FIRST_OBJ_NO_PRIORITY: 0x32,
  // Subgroup ID = First Object ID, Properties Present (Section 11.4.2: Type 0x33)
  FIRST_OBJ_EXT_NO_PRIORITY: 0x33,
  // Subgroup ID Field Present, No Properties (Section 11.4.2: Type 0x34)
  EXPLICIT_NO_PRIORITY: 0x34,
  // Subgroup ID Field Present, Properties Present (Section 11.4.2: Type 0x35)
  EXPLICIT_EXT_NO_PRIORITY: 0x35,

  // Priority Present = No, Contains End of Group = Yes
  // Subgroup ID = 0, No Properties (Section 11.4.2: Type 0x38)
  BASE_END_GROUP_NO_PRIORITY: 0x38,
  // Subgroup ID = 0, Properties Present (Section 11.4.2: Type 0x39)
  BASE_EXT_END_GROUP_NO_PRIORITY: 0x39,
  // Subgroup ID = First Object ID, No Properties (Section 11.4.2: Type 0x3A)
  FIRST_OBJ_END_GROUP_NO_PRIORITY: 0x3a,
  // Subgroup ID = First Object ID, Properties Present (Section 11.4.2: Type 0x3B)
  FIRST_OBJ_EXT_END_GROUP_NO_PRIORITY: 0x3b,
  // Subgroup ID Field Present, No Properties (Section 11.4.2: Type 0x3C)
  EXPLICIT_END_GROUP_NO_PRIORITY: 0x3c,
  // Subgroup ID Field Present, Properties Present (Section 11.4.2: Type 0x3D)
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
 * Object in a Subgroup
 */
export interface MoqtObject {
  groupId: bigint;
  subgroupId?: bigint;
  objectId: bigint;
  publisherPriority?: number;
  status: ObjectStatus;
  properties?: Uint8Array;
  payload: Uint8Array;
}

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
   * draft-ietf-moq-transport-18 Section 11.4.2
   */
  firstObject?: boolean;
}

/**
 * Check if subgroup header type has explicit Subgroup ID field
 * draft-ietf-moq-transport-18 Section 11.4.2
 */
function hasSubgroupIdField(headerType: number): boolean {
  const lowNibble = headerType & 0x0f;
  return lowNibble === 0x04 || lowNibble === 0x05 || lowNibble === 0x0c || lowNibble === 0x0d;
}

/**
 * Check if subgroup header type has Priority Present
 * draft-ietf-moq-transport-18 Section 11.4.2
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
 * draft-ietf-moq-transport-18 Section 11.4.2
 *
 * Types with bit 3 set (0x08) contain End of Group:
 * 0x18-0x1D (Priority Present) and 0x38-0x3D (No Priority)
 */
export function hasContainsEndOfGroup(headerType: number): boolean {
  const lowNibble = headerType & 0x0f;
  return lowNibble >= 0x08 && lowNibble <= 0x0d;
}

/**
 * Encode a Subgroup Header
 * draft-ietf-moq-transport-18 Section 11.4.2 Figure 24
 */
export function encodeSubgroupHeader(header: SubgroupHeader): Uint8Array {
  const parts: Uint8Array[] = [];

  // FIRST_OBJECT bit (0x40) がセットされている場合、Type に OR する
  const type = header.firstObject ? header.type | 0x40 : header.type;
  parts.push(encodeVarint(type));
  parts.push(encodeVarint(header.trackAlias));
  parts.push(encodeVarint(header.groupId));

  // Subgroup ID フィールド (明示的な Subgroup ID を持つタイプのみ)
  if (hasSubgroupIdField(header.type) && header.subgroupId !== undefined) {
    parts.push(encodeVarint(header.subgroupId));
  }

  // Publisher Priority (8 ビット) - Priority Present を持つタイプのみ
  if (hasPriorityPresent(header.type) && header.publisherPriority !== undefined) {
    parts.push(new Uint8Array([header.publisherPriority]));
  }

  const totalLength = parts.reduce((sum, p) => sum + p.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
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

  // draft-ietf-moq-transport-18 Section 11.4.2:
  // 不正なタイプ値を検証する
  // "Bit 4 MUST be set to 1. Bit 7 MUST be set to 0."
  // SUBGROUP_ID_MODE = 0b11 (0x16, 0x17, 0x1E, 0x1F, 0x36, 0x37, 0x3E, 0x3F,
  // 0x56, 0x57, 0x5E, 0x5F, 0x76, 0x77, 0x7E, 0x7F) は予約済み
  // 0b0XX1XXXX の形式でないタイプ値は不正
  const subgroupIdMode = (typeNum & 0x06) >> 1;
  if (subgroupIdMode === 0x03) {
    throw new ProtocolViolationError(
      `invalid subgroup header type: 0x${typeNum.toString(16)}, SUBGROUP_ID_MODE 0b11 is reserved`,
    );
  }
  if ((typeNum & 0x10) === 0 || (typeNum & 0x80) !== 0) {
    throw new ProtocolViolationError(
      `invalid subgroup header type: 0x${typeNum.toString(16)}, does not match form 0b0XX1XXXX`,
    );
  }

  // タイプに基づいて Subgroup ID フィールドの有無を判定
  // draft-ietf-moq-transport-18 Section 11.4.2:
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
  // draft-ietf-moq-transport-18 Section 11.4.2
  let publisherPriority: number | undefined;
  if (hasPriorityPresent(typeNum)) {
    publisherPriority = data[offset + totalConsumed];
    totalConsumed += 1;
  }

  // FIRST_OBJECT bit (0x40) の抽出
  const firstObject = (typeNum & 0x40) !== 0 ? true : undefined;

  return [
    {
      type: typeNum,
      trackAlias,
      groupId,
      subgroupId,
      publisherPriority,
      firstObject,
    },
    totalConsumed,
  ];
}

/**
 * Check if a subgroup header type has Properties Present
 * draft-ietf-moq-transport-18 Section 11.4.2:
 * Types with bit 0 set (odd types) have Properties Present
 */
export function hasPropertiesPresent(headerType: number): boolean {
  return (headerType & 0x01) === 0x01;
}

/**
 * Encode Object fields for Subgroup stream
 * draft-ietf-moq-transport-18 Section 11.4.2 Figure 25:
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

    // draft-ietf-moq-transport-18 Section 11.2.1.2:
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

  // draft-ietf-moq-transport-18 §11.2.1.1:
  // 非 NORMAL ステータスはペイロード長が 0 の場合のみエンコードされる。
  // payloadLength > 0 の場合、ステータスは wire に乗らないため ProtocolViolationError とする
  if (status !== ObjectStatus.NORMAL && payloadLength > 0n) {
    throw new ProtocolViolationError(`non-Normal status ${status} with non-empty payload`);
  }

  // ステータス (ペイロード長が 0 の場合のみ)
  // draft-ietf-moq-transport-18 Section 11.2.1.1:
  // "Zero-length objects explicitly encode the Normal status."
  if (payloadLength === 0n) {
    parts.push(encodeVarint(status));
  }

  const totalLength = parts.reduce((sum, p) => sum + p.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
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
 * draft-ietf-moq-transport-18 Section 11.4.2 Figure 25
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

    properties = data.slice(offset + totalConsumed, offset + totalConsumed + propertiesLength);
    totalConsumed += propertiesLength;
  }

  // ペイロード長
  const [payloadLength, payloadLenConsumed] = decodeVarint(data, offset + totalConsumed);
  totalConsumed += payloadLenConsumed;

  // ステータス (ペイロード長が 0 の場合のみ)
  // draft-ietf-moq-transport-18 Section 11.2.1.1:
  // "Zero-length objects explicitly encode the Normal status."
  let status: ObjectStatus = ObjectStatus.NORMAL;
  if (payloadLength === 0n) {
    const [statusVal, statusConsumed] = decodeVarint(data, offset + totalConsumed);
    status = Number(statusVal) as ObjectStatus;
    validateObjectStatus(status);
    totalConsumed += statusConsumed;

    // draft-ietf-moq-transport-18 Section 11.2.1.2:
    // "Any Object with status Normal can have properties (Section 2.5).
    // If an endpoint receives properties on an Object with status
    // that is not Normal, it MUST close the session with a PROTOCOL_VIOLATION."
    if (status !== ObjectStatus.NORMAL && propertiesLength > 0) {
      throw new ProtocolViolationError("properties on non-Normal status object");
    }
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

/**
 * Create a simple MoqtObject with payload
 */
export function createObject(
  groupId: bigint,
  objectId: bigint,
  payload: Uint8Array,
  options?: {
    subgroupId?: bigint;
    publisherPriority?: number;
  },
): MoqtObject {
  return {
    groupId,
    objectId,
    subgroupId: options?.subgroupId,
    publisherPriority: options?.publisherPriority,
    status: ObjectStatus.NORMAL,
    payload,
  };
}

/**
 * Object Datagram Type (Section 11.3.1)
 *
 * Section 11.3.1 (Object Datagram) / Figure 23 from draft-ietf-moq-transport-18:
 * | Type | End Of Group | Properties | Object ID | Priority | Status/Payload |
 * |------|--------------|------------|-----------|----------|----------------|
 * | 0x00 | No           | No         | Yes       | Yes      | Payload        |
 * | 0x01 | No           | Yes        | Yes       | Yes      | Payload        |
 * | 0x02 | Yes          | No         | Yes       | Yes      | Payload        |
 * | 0x03 | Yes          | Yes        | Yes       | Yes      | Payload        |
 * | 0x04 | No           | No         | No        | Yes      | Payload        |
 * | 0x05 | No           | Yes        | No        | Yes      | Payload        |
 * | 0x06 | Yes          | No         | No        | Yes      | Payload        |
 * | 0x07 | Yes          | Yes        | No        | Yes      | Payload        |
 * | 0x08 | No           | No         | Yes       | No       | Payload        |
 * | 0x09 | No           | Yes        | Yes       | No       | Payload        |
 * | 0x0A | Yes          | No         | Yes       | No       | Payload        |
 * | 0x0B | Yes          | Yes        | Yes       | No       | Payload        |
 * | 0x0C | No           | No         | No        | No       | Payload        |
 * | 0x0D | No           | Yes        | No        | No       | Payload        |
 * | 0x0E | Yes          | No         | No        | No       | Payload        |
 * | 0x0F | Yes          | Yes        | No        | No       | Payload        |
 * | 0x20 | No           | No         | Yes       | Yes      | Status         |
 * | 0x21 | No           | Yes        | Yes       | Yes      | Status         |
 * | 0x24 | No           | No         | No        | Yes      | Status         |
 * | 0x25 | No           | Yes        | No        | Yes      | Status         |
 * | 0x28 | No           | No         | Yes       | No       | Status         |
 * | 0x29 | No           | Yes        | Yes       | No       | Status         |
 * | 0x2C | No           | No         | No        | No       | Status         |
 * | 0x2D | No           | Yes        | No        | No       | Status         |
 */
export const DatagramType = {
  // ペイロードタイプ、Object ID あり、Priority Present (Section 11.3.1: 0x00-0x03)
  PAYLOAD_OBJ: 0x00,
  PAYLOAD_OBJ_EXT: 0x01,
  PAYLOAD_OBJ_END_GROUP: 0x02,
  PAYLOAD_OBJ_EXT_END_GROUP: 0x03,

  // ペイロードタイプ、Object ID なし (Object ID = 0)、Priority Present (Section 11.3.1: 0x04-0x07)
  PAYLOAD_NO_OBJ: 0x04,
  PAYLOAD_NO_OBJ_EXT: 0x05,
  PAYLOAD_NO_OBJ_END_GROUP: 0x06,
  PAYLOAD_NO_OBJ_EXT_END_GROUP: 0x07,

  // ペイロードタイプ、Object ID あり、Priority なし (Section 11.3.1: 0x08-0x0B)
  PAYLOAD_OBJ_NO_PRI: 0x08,
  PAYLOAD_OBJ_EXT_NO_PRI: 0x09,
  PAYLOAD_OBJ_END_GROUP_NO_PRI: 0x0a,
  PAYLOAD_OBJ_EXT_END_GROUP_NO_PRI: 0x0b,

  // ペイロードタイプ、Object ID なし、Priority なし (Section 11.3.1: 0x0C-0x0F)
  PAYLOAD_NO_OBJ_NO_PRI: 0x0c,
  PAYLOAD_NO_OBJ_EXT_NO_PRI: 0x0d,
  PAYLOAD_NO_OBJ_END_GROUP_NO_PRI: 0x0e,
  PAYLOAD_NO_OBJ_EXT_END_GROUP_NO_PRI: 0x0f,

  // ステータスタイプ、Object ID あり、Priority Present (Section 11.3.1: 0x20-0x21)
  STATUS_OBJ: 0x20,
  STATUS_OBJ_EXT: 0x21,

  // ステータスタイプ、Object ID なし、Priority Present (Section 11.3.1: 0x24-0x25)
  STATUS_NO_OBJ: 0x24,
  STATUS_NO_OBJ_EXT: 0x25,

  // ステータスタイプ、Object ID あり、Priority なし (Section 11.3.1: 0x28-0x29)
  STATUS_OBJ_NO_PRI: 0x28,
  STATUS_OBJ_EXT_NO_PRI: 0x29,

  // ステータスタイプ、Object ID なし (Object ID = 0)、Priority なし (Section 11.3.1: 0x2C-0x2D)
  // draft-ietf-moq-transport-18 Section 11.3.1:
  // 0x2C = STATUS(0x20) + DEFAULT_PRIORITY(0x08) + ZERO_OBJECT_ID(0x04)
  // 0x2D = STATUS(0x20) + DEFAULT_PRIORITY(0x08) + ZERO_OBJECT_ID(0x04) + PROPERTIES(0x01)
  STATUS_NO_OBJ_NO_PRI: 0x2c,
  STATUS_NO_OBJ_EXT_NO_PRI: 0x2d,
} as const;

export type DatagramType = (typeof DatagramType)[keyof typeof DatagramType];

/**
 * Object Datagram
 */
export interface ObjectDatagram {
  type: number;
  trackAlias: bigint;
  groupId: bigint;
  objectId: bigint;
  publisherPriority: number;
  properties?: Uint8Array;
  status?: ObjectStatus;
  payload?: Uint8Array;
}

/**
 * Object ID フィールドの有無を判定する
 *
 * draft-ietf-moq-transport-18 Section 11.3.1:
 * "The ZERO_OBJECT_ID bit (0x04) indicates when the Object ID field is present.
 * When set to 1, the Object ID field is omitted and the Object ID is 0.
 * When set to 0, the Object ID field is present."
 *
 * ZERO_OBJECT_ID ビット (0x04) は全タイプに一律に適用される
 */
function datagramHasObjectId(type: number): boolean {
  return (type & 0x04) === 0;
}

/**
 * Check if datagram type has Properties field
 */
function datagramHasProperties(type: number): boolean {
  return (type & 0x01) === 1;
}

/**
 * Check if datagram type is status type (no payload)
 */
function datagramIsStatusType(type: number): boolean {
  return type >= 0x20;
}

/**
 * Check if datagram type has Priority Present
 *
 * draft-ietf-moq-transport-18 Section 11.3.1 (Object Datagram):
 * Types 0x00-0x07 and 0x20-0x25 have Priority Present = Yes
 * Types 0x08-0x0F and 0x28-0x2D have Priority Present = No
 */
function datagramHasPriority(type: number): boolean {
  // タイプ 0x00-0x07 は Priority あり (Section 11.3.1)
  if (type <= 0x07) {
    return true;
  }
  // タイプ 0x08-0x0F は Priority なし (Section 11.3.1)
  if (type >= 0x08 && type <= 0x0f) {
    return false;
  }
  // タイプ 0x20-0x25 は Priority あり (Section 11.3.1)
  if (type >= 0x20 && type <= 0x25) {
    return true;
  }
  // タイプ 0x28-0x2D は Priority なし (Section 11.3.1)
  return false;
}

/**
 * Encode an Object Datagram
 * draft-ietf-moq-transport-18 Section 11.3.1
 */
export function encodeObjectDatagram(datagram: ObjectDatagram): Uint8Array {
  const parts: Uint8Array[] = [];

  parts.push(encodeVarint(datagram.type));
  parts.push(encodeVarint(datagram.trackAlias));
  parts.push(encodeVarint(datagram.groupId));

  if (datagramHasObjectId(datagram.type)) {
    parts.push(encodeVarint(datagram.objectId));
  } else if (datagram.objectId !== 0n) {
    throw new Error(`objectId must be 0 when ZERO_OBJECT_ID bit is set: got ${datagram.objectId}`);
  }

  // Priority Present の有無を判定 (Section 11.3.1: 0x08-0x0F, 0x28-0x2D は Priority なし)
  if (datagramHasPriority(datagram.type)) {
    parts.push(new Uint8Array([datagram.publisherPriority]));
  }

  if (datagramHasProperties(datagram.type)) {
    const extLen = datagram.properties?.length ?? 0;

    // draft-ietf-moq-transport-18 Section 11.2.1.2:
    // Non-Normal status objects must not have properties
    if (
      datagramIsStatusType(datagram.type) &&
      datagram.status !== ObjectStatus.NORMAL &&
      extLen > 0
    ) {
      throw new Error("Protocol violation: properties on non-Normal status object");
    }

    parts.push(encodeVarint(extLen));
    if (datagram.properties && datagram.properties.length > 0) {
      parts.push(datagram.properties);
    }
  }

  if (datagramIsStatusType(datagram.type)) {
    parts.push(encodeVarint(datagram.status ?? ObjectStatus.NORMAL));
  } else if (datagram.payload) {
    parts.push(datagram.payload);
  }

  const totalLength = parts.reduce((sum, p) => sum + p.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

/**
 * Decode an Object Datagram
 * draft-ietf-moq-transport-18 Section 11.3.1
 */
export function decodeObjectDatagram(data: Uint8Array, offset = 0): [ObjectDatagram, number] {
  let totalConsumed = 0;

  const [type, typeConsumed] = decodeVarint(data, offset + totalConsumed);
  totalConsumed += typeConsumed;

  const typeNum = Number(type);

  // draft-ietf-moq-transport-18 Section 11.3.1:
  // 不正なタイプ値を検証する
  // 0b00X0XXXX の形式でないタイプ値は不正
  if ((typeNum & 0x10) !== 0 || typeNum > 0x2f) {
    throw new ProtocolViolationError(
      `invalid datagram type: 0x${typeNum.toString(16)}, does not match form 0b00X0XXXX`,
    );
  }
  // STATUS (0x20) と END_OF_GROUP (0x02) の両方が設定されたタイプ値は不正
  if ((typeNum & 0x20) !== 0 && (typeNum & 0x02) !== 0) {
    throw new ProtocolViolationError(
      `invalid datagram type: 0x${typeNum.toString(16)}, STATUS and END_OF_GROUP bits are both set`,
    );
  }

  const [trackAlias, trackAliasConsumed] = decodeVarint(data, offset + totalConsumed);
  totalConsumed += trackAliasConsumed;

  const [groupId, groupIdConsumed] = decodeVarint(data, offset + totalConsumed);
  totalConsumed += groupIdConsumed;

  let objectId = 0n;
  if (datagramHasObjectId(typeNum)) {
    const [oid, oidConsumed] = decodeVarint(data, offset + totalConsumed);
    objectId = oid;
    totalConsumed += oidConsumed;
  }

  // Priority Present の有無を判定 (Section 11.3.1: 0x08-0x0F, 0x28-0x2D は Priority なし)
  let publisherPriority = 0;
  if (datagramHasPriority(typeNum)) {
    publisherPriority = data[offset + totalConsumed];
    totalConsumed += 1;
  }

  let properties: Uint8Array | undefined;
  let propertiesLength = 0;
  if (datagramHasProperties(typeNum)) {
    const [extLen, extLenConsumed] = decodeVarint(data, offset + totalConsumed);
    propertiesLength = Number(extLen);
    totalConsumed += extLenConsumed;

    // draft-ietf-moq-transport-18 Section 11.3.1:
    // "If an endpoint receives a datagram with the PROPERTIES bit set and
    //  an Properties Length of 0, it MUST close the session with a
    //  PROTOCOL_VIOLATION."
    if (propertiesLength === 0) {
      throw new ProtocolViolationError(
        "datagram has PROPERTIES bit set but Properties Length is 0",
      );
    }

    properties = data.slice(offset + totalConsumed, offset + totalConsumed + propertiesLength);
    totalConsumed += propertiesLength;
  }

  let status: ObjectStatus | undefined;
  let payload: Uint8Array | undefined;

  if (datagramIsStatusType(typeNum)) {
    const [statusVal, statusConsumed] = decodeVarint(data, offset + totalConsumed);
    status = Number(statusVal) as ObjectStatus;
    validateObjectStatus(status);
    totalConsumed += statusConsumed;

    // draft-ietf-moq-transport-18 Section 11.2.1.2:
    // "Any Object with status Normal can have properties (Section 2.5).
    // If an endpoint receives properties on an Object with status
    // that is not Normal, it MUST close the session with a PROTOCOL_VIOLATION."
    if (status !== ObjectStatus.NORMAL && propertiesLength > 0) {
      throw new ProtocolViolationError("properties on non-Normal status object");
    }
  } else {
    payload = data.slice(offset + totalConsumed);
    totalConsumed = data.length - offset;
  }

  return [
    {
      type: typeNum,
      trackAlias,
      groupId,
      objectId,
      publisherPriority,
      properties,
      status,
      payload,
    },
    totalConsumed,
  ];
}

/**
 * Fetch Header (Section 11.4.4)
 *
 * FETCH_HEADER {
 *   Type (i) = 0x05,
 *   Request ID (i),
 * }
 */
export const FetchHeaderType = 0x05;

export interface FetchHeader {
  type: typeof FetchHeaderType;
  requestId: bigint;
}

/**
 * Encode a Fetch Header
 *
 * リレーサーバー実装用。moqt-js はクライアント専用のため、ランタイムでは使用しない。
 * PBT（Property-Based Testing）でのラウンドトリップテストで使用。
 */
export function encodeFetchHeader(header: FetchHeader): Uint8Array {
  const parts: Uint8Array[] = [];

  parts.push(encodeVarint(header.type));
  parts.push(encodeVarint(header.requestId));

  const totalLength = parts.reduce((sum, p) => sum + p.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

/**
 * Decode a Fetch Header
 */
export function decodeFetchHeader(data: Uint8Array, offset = 0): [FetchHeader, number] {
  let totalConsumed = 0;

  const [type, typeConsumed] = decodeVarint(data, offset + totalConsumed);
  totalConsumed += typeConsumed;

  if (Number(type) !== FetchHeaderType) {
    throw new ProtocolViolationError(
      `invalid fetch header type: ${type}, expected ${FetchHeaderType}`,
    );
  }

  const [requestId, requestIdConsumed] = decodeVarint(data, offset + totalConsumed);
  totalConsumed += requestIdConsumed;

  return [
    {
      type: FetchHeaderType,
      requestId,
    },
    totalConsumed,
  ];
}

/**
 * Serialization Flags for Fetch Object (Section 11.4.4)
 *
 * Section 11.4.4.1 Table 8: Subgroup ID encoding (bits 0-1)
 * | Bitmask (flags & 0x03) | Meaning |
 * | 0x00 | Subgroup ID is zero |
 * | 0x01 | Subgroup ID is prior Object's Subgroup ID |
 * | 0x02 | Subgroup ID is prior Object's Subgroup ID + 1 |
 * | 0x03 | Subgroup ID field is present |
 *
 * Section 11.4.4.1 Table 9: Additional flags
 * | Bitmask | Condition if set |
 * | 0x04 | Object ID Delta is present (else prior + 1) |
 * | 0x08 | Group ID Delta is present (else prior Group ID) |
 * | 0x10 | Priority field is present (else prior Priority) |
 * | 0x20 | Properties field is present |
 * | 0x40 | Datagram: Subgroup ID の 2 ビットを無視 |
 *
 * End of Range (Section 11.4.4.2):
 * | 0x8C  | End of Non-Existent Range |
 * | 0x10C | End of Unknown Range      |
 */
export const FetchSerializationFlags = {
  // Subgroup ID encoding
  SUBGROUP_ZERO: 0x00,
  SUBGROUP_SAME: 0x01,
  SUBGROUP_PLUS_ONE: 0x02,
  SUBGROUP_PRESENT: 0x03,
  SUBGROUP_MASK: 0x03,

  // Additional flags
  OBJECT_ID_PRESENT: 0x04,
  GROUP_ID_PRESENT: 0x08,
  PRIORITY_PRESENT: 0x10,
  PROPERTIES_PRESENT: 0x20,
  /**
   * Datagram フラグ (0x40)
   * Subgroup ID の 2 ビットを無視する
   */
  DATAGRAM: 0x40,

  /**
   * End of Non-Existent Range (Section 11.4.4.2)
   *
   * draft-ietf-moq-transport-18:
   * 指定した Location までの Object が存在しないことを示す。
   * Group ID と Object ID フィールドが存在する。
   * Subgroup ID, Priority, Properties は存在しない。
   * draft-ietf-moq-transport-18 Section 11.4.4.2
   */
  END_OF_NON_EXISTENT_RANGE: 0x8c,
  /**
   * End of Unknown Range (Section 11.4.4.2)
   *
   * draft-ietf-moq-transport-18:
   * 指定した Location までの Object のステータスが不明であることを示す。
   * Group ID と Object ID フィールドが存在する。
   * Subgroup ID, Priority, Properties は存在しない。
   * draft-ietf-moq-transport-18 Section 11.4.4.2
   */
  END_OF_UNKNOWN_RANGE: 0x10c,
} as const;

/**
 * Fetch Object Fields (Figure 27 in Section 11.4.4)
 */
// draft-ietf-moq-transport-18 Section 11.2.1.1:
// "The Object Status is a field that is only present in objects that are
// delivered via a SUBSCRIPTION, and is absent in Objects delivered via a FETCH."
export interface FetchObjectFields {
  serializationFlags: number;
  groupId?: bigint;
  subgroupId?: bigint;
  objectId?: bigint;
  publisherPriority?: number;
  properties?: Uint8Array;
  payloadLength: bigint;
  payload?: Uint8Array;
}

/**
 * End of Range の種別
 *
 * draft-ietf-moq-transport-18 Section 11.4.4.2:
 * FETCH レスポンス内で Object が存在しない/不明な範囲を示す。
 */
export type EndOfRangeType = "non_existent" | "unknown";

/**
 * Decoded Fetch Object with resolved values
 */
export interface DecodedFetchObject {
  groupId: bigint;
  subgroupId: bigint;
  objectId: bigint;
  publisherPriority: number;
  properties?: Uint8Array;
  payloadLength: bigint;
  /**
   * End of Range indicator (Section 11.4.4.2)
   *
   * draft-ietf-moq-transport-18:
   * 設定されている場合、この Object は実際のデータではなく
   * 指定した Location までの範囲を示す End of Range indicator。
   */
  endOfRange?: EndOfRangeType;
}

/**
 * Context for decoding Fetch Objects (tracks prior object's values)
 */
export interface FetchObjectContext {
  groupId: bigint;
  subgroupId: bigint;
  objectId: bigint;
  publisherPriority: number;
}

/**
 * Encode Fetch Object Fields
 * draft-ietf-moq-transport-18 Section 11.4.4 Figure 27
 *
 * リレーサーバー実装用。moqt-js はクライアント専用のため、ランタイムでは使用しない。
 * PBT（Property-Based Testing）でのラウンドトリップテストで使用。
 */
export function encodeFetchObjectFields(
  fields: FetchObjectFields,
  includePayload = false,
  context: FetchObjectContext | null = null,
  groupOrder: GroupOrder = GroupOrder.ASCENDING,
): Uint8Array {
  const parts: Uint8Array[] = [];

  // Serialization Flags (varint)
  // draft-ietf-moq-transport-18: vi64 としてエンコード
  parts.push(encodeVarint(fields.serializationFlags));

  // End of Range の場合は Group ID と Object ID のみ
  if (
    fields.serializationFlags === FetchSerializationFlags.END_OF_NON_EXISTENT_RANGE ||
    fields.serializationFlags === FetchSerializationFlags.END_OF_UNKNOWN_RANGE
  ) {
    if (fields.groupId === undefined || fields.objectId === undefined) {
      throw new Error("Group ID and Object ID required for End of Range");
    }
    parts.push(encodeVarint(fields.groupId));
    parts.push(encodeVarint(fields.objectId));
    parts.push(encodeVarint(fields.payloadLength));

    const totalLength = parts.reduce((sum, p) => sum + p.length, 0);
    const result = new Uint8Array(totalLength);
    let resultOffset = 0;
    for (const part of parts) {
      result.set(part, resultOffset);
      resultOffset += part.length;
    }
    return result;
  }

  // Group ID (フラグ 0x08 がセットされている場合)
  // draft-ietf-moq-transport-18 §11.4.4.1 Table 9:
  // "If the Group Order is Ascending (default), the Group ID is the prior
  //  Object's Group ID plus the Group ID Delta + 1."
  // "If the Group Order is Descending, the Group ID is the prior
  //  Object's Group ID minus the (Group ID Delta + 1)."
  // エンコード時:
  //   Ascending: delta = currentGroupId - priorGroupId - 1n
  //   Descending: delta = priorGroupId - currentGroupId - 1n
  // 先頭オブジェクトまたは context 無しの場合は delta = currentGroupId (絶対値)
  if (fields.serializationFlags & FetchSerializationFlags.GROUP_ID_PRESENT) {
    if (fields.groupId === undefined) {
      throw new Error("Group ID required when GROUP_ID_PRESENT flag is set");
    }
    if (context === null) {
      parts.push(encodeVarint(fields.groupId));
    } else {
      const delta =
        groupOrder === GroupOrder.DESCENDING
          ? context.groupId - fields.groupId - 1n
          : fields.groupId - context.groupId - 1n;
      parts.push(encodeVarint(delta));
    }
  }

  // Subgroup ID (flags & 0x03 == 0x03 の場合)
  // Datagram 時 (0x40) は Subgroup ID フィールドをエンコードしない
  // draft-ietf-moq-transport-18 §11.4.4.1:
  // "the object has no Subgroup ID. The publisher MUST SET bit 0x40 to '1'."
  if (
    !(fields.serializationFlags & FetchSerializationFlags.DATAGRAM) &&
    (fields.serializationFlags & FetchSerializationFlags.SUBGROUP_MASK) ===
      FetchSerializationFlags.SUBGROUP_PRESENT
  ) {
    if (fields.subgroupId === undefined) {
      throw new Error("Subgroup ID required when SUBGROUP_PRESENT is set");
    }
    parts.push(encodeVarint(fields.subgroupId));
  }

  // Object ID (フラグ 0x04 がセットされている場合)
  // draft-ietf-moq-transport-18 §11.4.4.1 Table 9:
  // "When the Group ID Delta field is not present, the Object ID is the
  //  prior Object's ID plus the Object ID Delta if present."
  // エンコード時:
  //   - Group 不変 (!GROUP_ID_PRESENT) かつ context あり: delta = currentObjectId - priorObjectId
  //   - それ以外（先頭または Group 変化）: delta = currentObjectId (絶対値)
  if (fields.serializationFlags & FetchSerializationFlags.OBJECT_ID_PRESENT) {
    if (fields.objectId === undefined) {
      throw new Error("Object ID required when OBJECT_ID_PRESENT flag is set");
    }
    if (
      !(fields.serializationFlags & FetchSerializationFlags.GROUP_ID_PRESENT) &&
      context !== null
    ) {
      const delta = fields.objectId - context.objectId;
      parts.push(encodeVarint(delta));
    } else {
      parts.push(encodeVarint(fields.objectId));
    }
  }

  // Publisher Priority (フラグ 0x10 がセットされている場合)
  if (fields.serializationFlags & FetchSerializationFlags.PRIORITY_PRESENT) {
    if (fields.publisherPriority === undefined) {
      throw new Error("Publisher Priority required when PRIORITY_PRESENT flag is set");
    }
    parts.push(new Uint8Array([fields.publisherPriority]));
  }

  // プロパティ (フラグ 0x20 がセットされている場合)
  if (fields.serializationFlags & FetchSerializationFlags.PROPERTIES_PRESENT) {
    const extLen = fields.properties?.length ?? 0;
    parts.push(encodeVarint(extLen));
    if (fields.properties && fields.properties.length > 0) {
      parts.push(fields.properties);
    }
  }

  // Object Payload Length
  parts.push(encodeVarint(fields.payloadLength));

  // draft-ietf-moq-transport-18 Section 11.2.1.1:
  // "The Object Status is a field that is only present in objects that are
  // delivered via a SUBSCRIPTION, and is absent in Objects delivered via a FETCH."
  // Fetch Object には Object Status を含めない

  // Object Payload (オプション、指定時のみ含める)
  if (includePayload && fields.payload && fields.payloadLength > 0n) {
    parts.push(fields.payload);
  }

  const totalLength = parts.reduce((sum, p) => sum + p.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

/**
 * End of Range レコードをデコードする
 *
 * draft-ietf-moq-transport-18 §11.4.4.2: Group ID と Object ID のみが存在する。
 */
function decodeEndOfRange(
  data: Uint8Array,
  startOffset: number,
  flags: number,
  context: FetchObjectContext | null,
): [DecodedFetchObject, number, FetchObjectContext] {
  let consumed = 0;

  const [groupId, gidConsumed] = decodeVarint(data, startOffset + consumed);
  consumed += gidConsumed;

  const [objectId, oidConsumed] = decodeVarint(data, startOffset + consumed);
  consumed += oidConsumed;

  const [payloadLength, payloadLenConsumed] = decodeVarint(data, startOffset + consumed);
  consumed += payloadLenConsumed;

  const endOfRange: EndOfRangeType =
    flags === FetchSerializationFlags.END_OF_NON_EXISTENT_RANGE ? "non_existent" : "unknown";

  const newContext: FetchObjectContext = {
    groupId,
    subgroupId: context?.subgroupId ?? 0n,
    objectId,
    publisherPriority: context?.publisherPriority ?? 0,
  };

  return [
    {
      groupId,
      subgroupId: context?.subgroupId ?? 0n,
      objectId,
      publisherPriority: context?.publisherPriority ?? 0,
      payloadLength,
      endOfRange,
    },
    consumed,
    newContext,
  ];
}

/**
 * Fetch Object の Subgroup ID をデコードする
 *
 * draft-ietf-moq-transport-18 §11.4.4.1 Table 9:
 * "When encoding an Object with a Forwarding Preference of 'Datagram',
 *  the object has no Subgroup ID. When 0x40 is set, the subscriber MUST ignore the bits."
 *
 * @returns subgroupId, isDatagram, and extra bytes consumed
 */
function decodeFetchSubgroupId(
  data: Uint8Array,
  flags: number,
  offset: number,
  isFirst: boolean,
  context: FetchObjectContext | null,
): { subgroupId: bigint; isDatagram: boolean; consumed: number } {
  const isDatagram = (flags & FetchSerializationFlags.DATAGRAM) !== 0;
  let consumed = 0;

  // DATAGRAM + SUBGROUP_PRESENT: wire 上の Subgroup ID vi64 を読み飛ばす
  if (
    isDatagram &&
    (flags & FetchSerializationFlags.SUBGROUP_MASK) === FetchSerializationFlags.SUBGROUP_PRESENT
  ) {
    const [, skipConsumed] = decodeVarint(data, offset);
    consumed += skipConsumed;
  }

  if (isDatagram) {
    return { subgroupId: 0n, isDatagram: true, consumed };
  }

  const subgroupEncoding = flags & FetchSerializationFlags.SUBGROUP_MASK;
  switch (subgroupEncoding) {
    case FetchSerializationFlags.SUBGROUP_ZERO:
      return { subgroupId: 0n, isDatagram: false, consumed };
    case FetchSerializationFlags.SUBGROUP_SAME:
      if (isFirst || context === null) {
        throw new ProtocolViolationError("first object cannot use SUBGROUP_SAME");
      }
      return { subgroupId: context.subgroupId, isDatagram: false, consumed };
    case FetchSerializationFlags.SUBGROUP_PLUS_ONE:
      if (isFirst || context === null) {
        throw new ProtocolViolationError("first object cannot use SUBGROUP_PLUS_ONE");
      }
      return { subgroupId: context.subgroupId + 1n, isDatagram: false, consumed };
    case FetchSerializationFlags.SUBGROUP_PRESENT: {
      const [sid, sidConsumed] = decodeVarint(data, offset + consumed);
      return { subgroupId: sid, isDatagram: false, consumed: consumed + sidConsumed };
    }
    default:
      throw new ProtocolViolationError(`invalid subgroup encoding: ${subgroupEncoding}`);
  }
}

/**
 * Decode Fetch Object Fields
 * draft-ietf-moq-transport-18 Section 11.4.4 Figure 27
 *
 * @param data - Data buffer
 * @param context - Context with prior object's values (required after first object)
 * @param offset - Starting offset in buffer
 * @param isFirst - Whether this is the first object (no prior context allowed)
 * @param groupOrder - Group Order (GroupOrder.ASCENDING or GroupOrder.DESCENDING)
 */
export function decodeFetchObjectFields(
  data: Uint8Array,
  context: FetchObjectContext | null,
  offset = 0,
  isFirst = false,
  groupOrder: GroupOrder = GroupOrder.ASCENDING,
): [DecodedFetchObject, number, FetchObjectContext] {
  let totalConsumed = 0;

  // Serialization Flags (varint)
  // draft-ietf-moq-transport-18: vi64 としてエンコードされる
  const [flagsRaw, flagsConsumed] = decodeVarint(data, offset + totalConsumed);
  const flags = Number(flagsRaw);
  totalConsumed += flagsConsumed;

  // End of Range チェック (Section 11.4.4.2)
  if (
    flags === FetchSerializationFlags.END_OF_NON_EXISTENT_RANGE ||
    flags === FetchSerializationFlags.END_OF_UNKNOWN_RANGE
  ) {
    const [result, consumed, newContext] = decodeEndOfRange(
      data,
      offset + totalConsumed,
      flags,
      context,
    );
    return [result, totalConsumed + consumed, newContext];
  }

  // draft-ietf-moq-transport-18 Section 11.4.4 Table 7:
  // 「When less than 128, the bits represent flags described below.
  //  The following additional values are defined: 0x8C (End of Non-Existent Range),
  //  0x10C (End of Unknown Range). Any other value is a PROTOCOL_VIOLATION.」
  // 0x8C / 0x10C は上の End of Range チェックで処理済み。
  // それ以外の 128 以上の値は不正。
  if (flags >= 128) {
    throw new ProtocolViolationError(
      `invalid fetch serialization flags: 0x${flags.toString(16)}, expected flags < 128, 0x8C, or 0x10C`,
    );
  }

  // Group ID
  // draft-ietf-moq-transport-18 §11.4.4.1 Table 9:
  // Ascending: "The Group ID is the prior Object's Group ID plus the Group ID Delta + 1."
  // Descending: "The Group ID is the prior Object's Group ID minus the (Group ID Delta + 1)."
  // "If the computed Group ID would be less than 0 or greater than 2^64-1, the Subscriber MUST close the Session with error 'PROTOCOL_VIOLATION'."
  // 先頭オブジェクト (isFirst) の場合は delta が絶対値と等価。
  let groupId: bigint;
  if (flags & FetchSerializationFlags.GROUP_ID_PRESENT) {
    const [delta, deltaConsumed] = decodeVarint(data, offset + totalConsumed);
    if (isFirst || context === null) {
      groupId = delta;
    } else if (groupOrder === GroupOrder.DESCENDING) {
      groupId = context.groupId - delta - 1n;
    } else {
      groupId = context.groupId + delta + 1n;
    }
    totalConsumed += deltaConsumed;
  } else {
    if (isFirst || context === null) {
      throw new ProtocolViolationError("first object must have GROUP_ID_PRESENT flag set");
    }
    groupId = context.groupId;
  }

  // Group ID の範囲検証: 0 以上 2^64-1 以下
  // draft-ietf-moq-transport-18 §11.4.4.1 Table 9
  if (groupId < 0n || groupId > maxObjectId) {
    throw new ProtocolViolationError(
      `computed group id out of range: ${groupId}, expected 0 to 2^64-1`,
    );
  }

  // Subgroup ID をデコード（DATAGRAM フラグの処理を含む）
  // draft-ietf-moq-transport-18 §11.4.4.1 Table 9:
  // "When encoding an Object with a Forwarding Preference of 'Datagram',
  //  the object has no Subgroup ID. When 0x40 is set, the subscriber MUST ignore the bits."
  const {
    subgroupId,
    isDatagram,
    consumed: subgroupConsumed,
  } = decodeFetchSubgroupId(data, flags, offset + totalConsumed, isFirst, context);
  totalConsumed += subgroupConsumed;

  // Object ID
  // draft-ietf-moq-transport-18 §11.4.4.1 Table 9:
  // "When the Group ID Delta field is not present, the Object ID is the
  //  prior Object's ID plus the Object ID Delta if present."
  // Group 不変時 (!GROUP_ID_PRESENT) かつ非先頭の場合、delta は prior + delta。
  // 先頭オブジェクトまたは Group 変化時は delta が絶対値。
  let objectId: bigint;
  if (flags & FetchSerializationFlags.OBJECT_ID_PRESENT) {
    const [delta, deltaConsumed] = decodeVarint(data, offset + totalConsumed);
    if (!(flags & FetchSerializationFlags.GROUP_ID_PRESENT) && !isFirst && context !== null) {
      objectId = context.objectId + delta;
    } else {
      objectId = delta;
    }
    totalConsumed += deltaConsumed;
  } else {
    if (isFirst || context === null) {
      throw new ProtocolViolationError("first object must have OBJECT_ID_PRESENT flag set");
    }
    objectId = context.objectId + 1n;
  }

  // Object ID の範囲検証: 0 以上 2^64-1 以下
  // draft-ietf-moq-transport-18 §11.4.4.1 Table 9:
  // "If the computed Object ID would be greater than 2^64-1, the
  //  Subscriber MUST close the Session with error 'PROTOCOL_VIOLATION'."
  if (objectId > maxObjectId) {
    throw new ProtocolViolationError(
      `computed object id out of range: ${objectId}, expected 0 to 2^64-1`,
    );
  }

  // Publisher Priority
  let publisherPriority: number;
  if (flags & FetchSerializationFlags.PRIORITY_PRESENT) {
    publisherPriority = data[offset + totalConsumed];
    totalConsumed += 1;

    // draft-ietf-moq-transport-18:
    // 同一 Subgroup 内のオブジェクトは同じ Priority を持つ必要がある。
    // 異なる Priority を検出した場合は MALFORMED_TRACK エラー。
    // Datagram オブジェクトは Subgroup に属さないためチェックをスキップする。
    // draft-ietf-moq-transport-18 Section 11.4.4
    if (!isDatagram && context !== null && subgroupId === context.subgroupId) {
      if (publisherPriority !== context.publisherPriority) {
        throw new ProtocolViolationError(
          `malformed track: different priorities in same subgroup ` +
            `(subgroup=${subgroupId}, expected=${context.publisherPriority}, actual=${publisherPriority})`,
        );
      }
    }
  } else {
    // draft-ietf-moq-transport-18 §11.4.4.1 Table 9:
    // 先頭オブジェクトに MUST なのは Group ID Delta と Object ID Delta のみ。
    // PRIORITY_PRESENT は任意であり、省略時はデフォルト値 128 を使用する。
    if (context === null) {
      publisherPriority = 128;
    } else {
      publisherPriority = context.publisherPriority;
    }
  }

  // Properties
  let properties: Uint8Array | undefined;
  if (flags & FetchSerializationFlags.PROPERTIES_PRESENT) {
    const [extLen, extLenConsumed] = decodeVarint(data, offset + totalConsumed);
    totalConsumed += extLenConsumed;

    if (extLen > 0) {
      properties = data.slice(offset + totalConsumed, offset + totalConsumed + Number(extLen));
      totalConsumed += Number(extLen);
    }
  }

  // Object Payload Length
  const [payloadLength, payloadLenConsumed] = decodeVarint(data, offset + totalConsumed);
  totalConsumed += payloadLenConsumed;

  // draft-ietf-moq-transport-18 Section 11.2.1.1:
  // "The Object Status is a field that is only present in objects that are
  // delivered via a SUBSCRIPTION, and is absent in Objects delivered via a FETCH."
  // Fetch Object には Object Status は存在しない

  // 次のオブジェクトのためにコンテキストを更新
  // Datagram オブジェクトは Subgroup ID を持たないため、
  // コンテキストには Datagram 以前の実際の Subgroup ID を伝搬させる
  const newContext: FetchObjectContext = {
    groupId,
    subgroupId: isDatagram ? (context?.subgroupId ?? 0n) : subgroupId,
    objectId,
    publisherPriority,
  };

  return [
    {
      groupId,
      subgroupId,
      objectId,
      publisherPriority,
      properties,
      payloadLength,
    },
    totalConsumed,
    newContext,
  ];
}

/**
 * Create serialization flags for first Fetch object
 * First object must have all fields present
 *
 * @param hasExtensions - Whether the object has extension properties
 * @param isDatagram - Whether the object uses Datagram forwarding preference
 */
export function createFirstFetchObjectFlags(hasExtensions = false, isDatagram = false): number {
  let flags =
    FetchSerializationFlags.GROUP_ID_PRESENT |
    FetchSerializationFlags.OBJECT_ID_PRESENT |
    FetchSerializationFlags.PRIORITY_PRESENT;

  if (isDatagram) {
    // Datagram 時は Subgroup ID フィールドなし、DATAGRAM ビットを設定
    // draft-ietf-moq-transport-18 §11.4.4.1:
    // "the publisher MUST SET bit 0x40 to '1'"
    // 下位 2 ビットは SUBGROUP_ZERO (0x00) が推奨
    flags |= FetchSerializationFlags.DATAGRAM;
  } else {
    flags |= FetchSerializationFlags.SUBGROUP_PRESENT;
  }

  if (hasExtensions) {
    flags |= FetchSerializationFlags.PROPERTIES_PRESENT;
  }

  return flags;
}

/**
 * Create serialization flags based on delta from prior object
 */
export function createFetchObjectFlags(
  current: { groupId: bigint; subgroupId: bigint; objectId: bigint; publisherPriority: number },
  prior: FetchObjectContext,
  hasExtensions = false,
): number {
  let flags = 0;

  // Group ID
  if (current.groupId !== prior.groupId) {
    flags |= FetchSerializationFlags.GROUP_ID_PRESENT;
  }

  // Subgroup ID
  if (current.subgroupId === 0n) {
    flags |= FetchSerializationFlags.SUBGROUP_ZERO;
  } else if (current.subgroupId === prior.subgroupId) {
    flags |= FetchSerializationFlags.SUBGROUP_SAME;
  } else if (current.subgroupId === prior.subgroupId + 1n) {
    flags |= FetchSerializationFlags.SUBGROUP_PLUS_ONE;
  } else {
    flags |= FetchSerializationFlags.SUBGROUP_PRESENT;
  }

  // Object ID
  if (current.objectId !== prior.objectId + 1n) {
    flags |= FetchSerializationFlags.OBJECT_ID_PRESENT;
  }

  // Publisher Priority
  if (current.publisherPriority !== prior.publisherPriority) {
    flags |= FetchSerializationFlags.PRIORITY_PRESENT;
  }

  // Properties
  if (hasExtensions) {
    flags |= FetchSerializationFlags.PROPERTIES_PRESENT;
  }

  return flags;
}
