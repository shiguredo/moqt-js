/**
 * MOQT Data Stream
 * draft-ietf-moq-transport-17 Section 10
 *
 * Data streams carry Objects via Subgroups or Datagrams.
 *
 * draft-ietf-moq-transport-16:
 * 同一トラック内で Datagram と Subgroup (Stream) の混在が許可される。
 * Publisher は同じトラックのオブジェクトを Datagram と Stream の両方で送信できる。
 * https://github.com/moq-wg/moq-transport/pull/1350
 */

import { decodeVarint, encodeVarint } from "./varint";
import { ObjectStatus } from "./message/types";

/**
 * Object Status の値を検証する
 *
 * draft-ietf-moq-transport-17 Section 10.2.1.1:
 * "Any other value SHOULD be treated as a protocol error and the session
 *  SHOULD be closed with a PROTOCOL_VIOLATION."
 */
function validateObjectStatus(status: number): void {
  if (
    status !== ObjectStatus.NORMAL &&
    status !== ObjectStatus.END_OF_GROUP &&
    status !== ObjectStatus.END_OF_TRACK
  ) {
    throw new Error(`invalid object status: 0x${status.toString(16)}, expected 0x0, 0x3, or 0x4`);
  }
}

/**
 * Subgroup Header Type (Section 10.4.2)
 *
 * Type values 0x10-0x1D (Priority Present = Yes)
 * Type values 0x30-0x3D (Priority Present = No)
 *
 * Table 6 from draft-ietf-moq-transport-16:
 * | Type | Subgroup ID Field | Subgroup ID Value | Extensions | End of Group | Priority |
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
 */
export const SubgroupHeaderType = {
  // Priority Present = Yes, Contains End of Group = No
  // Subgroup ID = 0, No Extensions
  BASE: 0x10,
  // Subgroup ID = 0, Extensions Present
  BASE_EXT: 0x11,
  // Subgroup ID = First Object ID, No Extensions
  FIRST_OBJ: 0x12,
  // Subgroup ID = First Object ID, Extensions Present
  FIRST_OBJ_EXT: 0x13,
  // Subgroup ID Field Present, No Extensions
  EXPLICIT: 0x14,
  // Subgroup ID Field Present, Extensions Present
  EXPLICIT_EXT: 0x15,

  // Priority Present = Yes, Contains End of Group = Yes
  // Subgroup ID = 0, No Extensions
  BASE_END_GROUP: 0x18,
  // Subgroup ID = 0, Extensions Present
  BASE_EXT_END_GROUP: 0x19,
  // Subgroup ID = First Object ID, No Extensions
  FIRST_OBJ_END_GROUP: 0x1a,
  // Subgroup ID = First Object ID, Extensions Present
  FIRST_OBJ_EXT_END_GROUP: 0x1b,
  // Subgroup ID Field Present, No Extensions
  EXPLICIT_END_GROUP: 0x1c,
  // Subgroup ID Field Present, Extensions Present
  EXPLICIT_EXT_END_GROUP: 0x1d,

  // Priority Present = No, Contains End of Group = No
  // Subgroup ID = 0, No Extensions
  BASE_NO_PRIORITY: 0x30,
  // Subgroup ID = 0, Extensions Present
  BASE_EXT_NO_PRIORITY: 0x31,
  // Subgroup ID = First Object ID, No Extensions
  FIRST_OBJ_NO_PRIORITY: 0x32,
  // Subgroup ID = First Object ID, Extensions Present
  FIRST_OBJ_EXT_NO_PRIORITY: 0x33,
  // Subgroup ID Field Present, No Extensions
  EXPLICIT_NO_PRIORITY: 0x34,
  // Subgroup ID Field Present, Extensions Present
  EXPLICIT_EXT_NO_PRIORITY: 0x35,

  // Priority Present = No, Contains End of Group = Yes
  // Subgroup ID = 0, No Extensions
  BASE_END_GROUP_NO_PRIORITY: 0x38,
  // Subgroup ID = 0, Extensions Present
  BASE_EXT_END_GROUP_NO_PRIORITY: 0x39,
  // Subgroup ID = First Object ID, No Extensions
  FIRST_OBJ_END_GROUP_NO_PRIORITY: 0x3a,
  // Subgroup ID = First Object ID, Extensions Present
  FIRST_OBJ_EXT_END_GROUP_NO_PRIORITY: 0x3b,
  // Subgroup ID Field Present, No Extensions
  EXPLICIT_END_GROUP_NO_PRIORITY: 0x3c,
  // Subgroup ID Field Present, Extensions Present
  EXPLICIT_EXT_END_GROUP_NO_PRIORITY: 0x3d,
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
}

/**
 * Check if subgroup header type has explicit Subgroup ID field
 * draft-ietf-moq-transport-16 Section 10.4.2 Table 6
 */
function hasSubgroupIdField(headerType: number): boolean {
  const lowNibble = headerType & 0x0f;
  return lowNibble === 0x04 || lowNibble === 0x05 || lowNibble === 0x0c || lowNibble === 0x0d;
}

/**
 * Check if subgroup header type has Priority Present
 * draft-ietf-moq-transport-16 Section 10.4.2 Table 6
 *
 * Types 0x10-0x1D have Priority Present = Yes
 * Types 0x30-0x3D have Priority Present = No
 */
function hasPriorityPresent(headerType: number): boolean {
  return headerType >= 0x10 && headerType <= 0x1d;
}

/**
 * Check if subgroup header type contains End of Group
 * draft-ietf-moq-transport-16 Section 10.4.2 Table 6
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
 * draft-ietf-moq-transport-16 Section 10.4.2 Figure 28
 */
export function encodeSubgroupHeader(header: SubgroupHeader): Uint8Array {
  const parts: Uint8Array[] = [];

  parts.push(encodeVarint(header.type));
  parts.push(encodeVarint(header.trackAlias));
  parts.push(encodeVarint(header.groupId));

  // Subgroup ID field (only for types with explicit Subgroup ID)
  if (hasSubgroupIdField(header.type) && header.subgroupId !== undefined) {
    parts.push(encodeVarint(header.subgroupId));
  }

  // Publisher Priority (8 bits) - only for types with Priority Present
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

  // draft-ietf-moq-transport-17 Section 10.4.2:
  // 不正なタイプ値を検証する
  // SUBGROUP_ID_MODE = 0b11 (0x16, 0x17, 0x1E, 0x1F, 0x36, 0x37, 0x3E, 0x3F) は予約済み
  // 0b00X1XXXX の形式でないタイプ値は不正
  const subgroupIdMode = (typeNum & 0x06) >> 1;
  if (subgroupIdMode === 0x03) {
    throw new Error(
      `invalid subgroup header type: 0x${typeNum.toString(16)}, SUBGROUP_ID_MODE 0b11 is reserved`,
    );
  }
  if ((typeNum & 0x10) === 0) {
    throw new Error(
      `invalid subgroup header type: 0x${typeNum.toString(16)}, does not match form 0b00X1XXXX`,
    );
  }

  // Subgroup ID field present check based on type
  // draft-ietf-moq-transport-17 Section 10.4.2 Table 6:
  // - Types 0x14-0x15, 0x1C-0x1D, 0x34-0x35, 0x3C-0x3D: Subgroup ID Field Present
  // - Types 0x10-0x11, 0x18-0x19, 0x30-0x31, 0x38-0x39: Subgroup ID = 0
  // - Types 0x12-0x13, 0x1A-0x1B, 0x32-0x33, 0x3A-0x3B: Subgroup ID = First Object ID (no field)
  const lowNibble = typeNum & 0x0f;
  if (lowNibble === 0x04 || lowNibble === 0x05 || lowNibble === 0x0c || lowNibble === 0x0d) {
    // Explicit Subgroup ID field present
    const [sid, sidConsumed] = decodeVarint(data, offset + totalConsumed);
    subgroupId = sid;
    totalConsumed += sidConsumed;
  } else if (lowNibble === 0x00 || lowNibble === 0x01 || lowNibble === 0x08 || lowNibble === 0x09) {
    // Subgroup ID = 0
    subgroupId = 0n;
  }
  // For types 0x02, 0x03, 0x0A, 0x0B: Subgroup ID = First Object ID (will be set when first object is read)

  // Publisher Priority (8 bits)
  // draft-ietf-moq-transport-16 Section 10.4.2 Table 6
  let publisherPriority: number | undefined;
  if (hasPriorityPresent(typeNum)) {
    publisherPriority = data[offset + totalConsumed];
    totalConsumed += 1;
  }

  return [
    {
      type: typeNum,
      trackAlias,
      groupId,
      subgroupId,
      publisherPriority,
    },
    totalConsumed,
  ];
}

/**
 * Check if a subgroup header type has Extensions Present
 * draft-ietf-moq-transport-16 Section 10.4.2 Table 6:
 * Types with bit 0 set (odd types) have Extensions Present
 */
export function hasPropertiesPresent(headerType: number): boolean {
  return (headerType & 0x01) === 0x01;
}

/**
 * Encode Object fields for Subgroup stream
 * draft-ietf-moq-transport-16 Section 10.4.2 Figure 29:
 * {
 *   Object ID Delta (i),
 *   [Extensions (..),]          <-- Only if header type has Extensions Present
 *   Object Payload Length (i),
 *   [Object Status (i),]        <-- Only if payload length is 0
 *   [Object Payload (..),]
 * }
 *
 * @param objectIdDelta - Object ID delta from previous object (or absolute ID for first object)
 * @param payloadLength - Length of payload
 * @param headerType - Subgroup header type to determine if properties are present
 * @param status - Object status (only encoded if payload length is 0)
 * @param properties - Extensions data (only encoded if header type has Extensions Present)
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

  // Extensions (only if header type has Extensions Present)
  if (hasPropertiesPresent(headerType)) {
    const extLen = properties?.length ?? 0;

    // draft-ietf-moq-transport-16 Section 10.2.1.2:
    // Non-Normal status objects must not have extension headers
    if (status !== ObjectStatus.NORMAL && extLen > 0) {
      throw new Error("Protocol violation: extension headers on non-Normal status object");
    }

    parts.push(encodeVarint(extLen));
    if (properties && properties.length > 0) {
      parts.push(properties);
    }
  }

  // Payload length
  parts.push(encodeVarint(payloadLength));

  // Status (only if payload length is 0)
  // draft-ietf-moq-transport-16 Section 10.2.1.1:
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
 * draft-ietf-moq-transport-16 Section 10.4.2 Figure 29
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

  // Extensions (only if header type has Extensions Present)
  let propertiesLength = 0;
  let properties = new Uint8Array(0);
  if (hasPropertiesPresent(headerType)) {
    const [extLen, extLenConsumed] = decodeVarint(data, offset + totalConsumed);
    propertiesLength = Number(extLen);
    totalConsumed += extLenConsumed;

    properties = data.slice(offset + totalConsumed, offset + totalConsumed + propertiesLength);
    totalConsumed += propertiesLength;
  }

  // Payload length
  const [payloadLength, payloadLenConsumed] = decodeVarint(data, offset + totalConsumed);
  totalConsumed += payloadLenConsumed;

  // Status (only present if payload length is 0)
  // draft-ietf-moq-transport-16 Section 10.2.1.1:
  // "Zero-length objects explicitly encode the Normal status."
  let status: ObjectStatus = ObjectStatus.NORMAL;
  if (payloadLength === 0n) {
    const [statusVal, statusConsumed] = decodeVarint(data, offset + totalConsumed);
    status = Number(statusVal) as ObjectStatus;
    validateObjectStatus(status);
    totalConsumed += statusConsumed;

    // draft-ietf-moq-transport-17 Section 10.2.1.2:
    // "Any Object with status Normal can have extension headers.
    // If an endpoint receives extension headers on Objects with status
    // that is not Normal, it MUST close the session with a PROTOCOL_VIOLATION."
    if (status !== ObjectStatus.NORMAL && propertiesLength > 0) {
      throw new Error("Protocol violation: extension headers on non-Normal status object");
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
 * Object Datagram Type (Section 10.3.1)
 *
 * Table 5 from draft-ietf-moq-transport-16:
 * | Type | End Of Group | Extensions | Object ID | Priority | Status/Payload |
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
 * | 0x2C | No           | No         | Yes       | No       | Status         |
 * | 0x2D | No           | Yes        | Yes       | No       | Status         |
 */
export const DatagramType = {
  // Payload types with Object ID, Priority Present
  PAYLOAD_OBJ: 0x00,
  PAYLOAD_OBJ_EXT: 0x01,
  PAYLOAD_OBJ_END_GROUP: 0x02,
  PAYLOAD_OBJ_EXT_END_GROUP: 0x03,

  // Payload types without Object ID (Object ID = 0), Priority Present
  PAYLOAD_NO_OBJ: 0x04,
  PAYLOAD_NO_OBJ_EXT: 0x05,
  PAYLOAD_NO_OBJ_END_GROUP: 0x06,
  PAYLOAD_NO_OBJ_EXT_END_GROUP: 0x07,

  // Payload types with Object ID, No Priority
  PAYLOAD_OBJ_NO_PRI: 0x08,
  PAYLOAD_OBJ_EXT_NO_PRI: 0x09,
  PAYLOAD_OBJ_END_GROUP_NO_PRI: 0x0a,
  PAYLOAD_OBJ_EXT_END_GROUP_NO_PRI: 0x0b,

  // Payload types without Object ID, No Priority
  PAYLOAD_NO_OBJ_NO_PRI: 0x0c,
  PAYLOAD_NO_OBJ_EXT_NO_PRI: 0x0d,
  PAYLOAD_NO_OBJ_END_GROUP_NO_PRI: 0x0e,
  PAYLOAD_NO_OBJ_EXT_END_GROUP_NO_PRI: 0x0f,

  // Status types with Object ID, Priority Present
  STATUS_OBJ: 0x20,
  STATUS_OBJ_EXT: 0x21,

  // Status types without Object ID, Priority Present
  STATUS_NO_OBJ: 0x24,
  STATUS_NO_OBJ_EXT: 0x25,

  // Status types with Object ID, No Priority (0x28-0x29)
  STATUS_OBJ_NO_PRI: 0x28,
  STATUS_OBJ_EXT_NO_PRI: 0x29,

  // Status types with Object ID, No Priority (0x2C-0x2D)
  // draft-15 Table 5: 0x2C/0x2D は Object ID = Yes
  STATUS_OBJ_NO_PRI_2: 0x2c,
  STATUS_OBJ_EXT_NO_PRI_2: 0x2d,
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
 * Check if datagram type has Object ID field
 *
 * draft-ietf-moq-transport-16 Section 10.3.1 Table 5:
 * - Payload types (0x00-0x0F): bit 2 (0x04) = 0 なら Object ID あり
 * - Status types (0x20-0x2D): 0x24, 0x25 のみ Object ID なし、他は Object ID あり
 */
function datagramHasObjectId(type: number): boolean {
  // Status types
  if (type >= 0x20) {
    // 0x24, 0x25 のみ Object ID なし
    return type !== 0x24 && type !== 0x25;
  }
  // Payload types: bit 2 (0x04) = 0 なら Object ID あり
  return (type & 0x04) === 0;
}

/**
 * Check if datagram type has Extensions field
 */
function datagramHasExtensions(type: number): boolean {
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
 * draft-ietf-moq-transport-16 Section 10.3.1 Table 5:
 * Types 0x00-0x07 and 0x20-0x25 have Priority Present = Yes
 * Types 0x08-0x0F and 0x28-0x2D have Priority Present = No
 */
function datagramHasPriority(type: number): boolean {
  // Types 0x00-0x07 have Priority
  if (type <= 0x07) {
    return true;
  }
  // Types 0x08-0x0F don't have Priority
  if (type >= 0x08 && type <= 0x0f) {
    return false;
  }
  // Types 0x20-0x25 have Priority
  if (type >= 0x20 && type <= 0x25) {
    return true;
  }
  // Types 0x28-0x2D don't have Priority
  return false;
}

/**
 * Encode an Object Datagram
 * draft-ietf-moq-transport-16 Section 10.3.1
 */
export function encodeObjectDatagram(datagram: ObjectDatagram): Uint8Array {
  const parts: Uint8Array[] = [];

  parts.push(encodeVarint(datagram.type));
  parts.push(encodeVarint(datagram.trackAlias));
  parts.push(encodeVarint(datagram.groupId));

  if (datagramHasObjectId(datagram.type)) {
    parts.push(encodeVarint(datagram.objectId));
  }

  // Priority Present check (types 0x08-0x0F and 0x28-0x2D don't have Priority)
  if (datagramHasPriority(datagram.type)) {
    parts.push(new Uint8Array([datagram.publisherPriority]));
  }

  if (datagramHasExtensions(datagram.type)) {
    const extLen = datagram.properties?.length ?? 0;

    // draft-ietf-moq-transport-16 Section 10.2.1.2:
    // Non-Normal status objects must not have extension headers
    if (
      datagramIsStatusType(datagram.type) &&
      datagram.status !== ObjectStatus.NORMAL &&
      extLen > 0
    ) {
      throw new Error("Protocol violation: extension headers on non-Normal status object");
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
 * draft-ietf-moq-transport-16 Section 10.3.1
 */
export function decodeObjectDatagram(data: Uint8Array, offset = 0): [ObjectDatagram, number] {
  let totalConsumed = 0;

  const [type, typeConsumed] = decodeVarint(data, offset + totalConsumed);
  totalConsumed += typeConsumed;

  const typeNum = Number(type);

  // draft-ietf-moq-transport-17 Section 10.3.1:
  // 不正なタイプ値を検証する
  // 0b00X0XXXX の形式でないタイプ値は不正
  if ((typeNum & 0x10) !== 0 || typeNum > 0x2f) {
    throw new Error(
      `invalid datagram type: 0x${typeNum.toString(16)}, does not match form 0b00X0XXXX`,
    );
  }
  // STATUS (0x20) と END_OF_GROUP (0x02) の両方が設定されたタイプ値は不正
  if ((typeNum & 0x20) !== 0 && (typeNum & 0x02) !== 0) {
    throw new Error(
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

  // Priority Present check (types 0x08-0x0F and 0x28-0x2D don't have Priority)
  let publisherPriority = 0;
  if (datagramHasPriority(typeNum)) {
    publisherPriority = data[offset + totalConsumed];
    totalConsumed += 1;
  }

  let properties: Uint8Array | undefined;
  let propertiesLength = 0;
  if (datagramHasExtensions(typeNum)) {
    const [extLen, extLenConsumed] = decodeVarint(data, offset + totalConsumed);
    propertiesLength = Number(extLen);
    totalConsumed += extLenConsumed;

    // draft-ietf-moq-transport-17 Section 10.3.1:
    // "If an endpoint receives a datagram with the PROPERTIES bit set and
    //  an Properties Length of 0, it MUST close the session with a
    //  PROTOCOL_VIOLATION."
    if (propertiesLength === 0) {
      throw new Error("datagram has PROPERTIES bit set but Properties Length is 0");
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

    // draft-ietf-moq-transport-17 Section 10.2.1.2:
    // "Any Object with status Normal can have extension headers.
    // If an endpoint receives extension headers on Objects with status
    // that is not Normal, it MUST close the session with a PROTOCOL_VIOLATION."
    if (status !== ObjectStatus.NORMAL && propertiesLength > 0) {
      throw new Error("Protocol violation: extension headers on non-Normal status object");
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
 * Fetch Header (Section 10.4.4)
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
    throw new Error(`Invalid Fetch Header type: ${type}, expected ${FetchHeaderType}`);
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
 * Serialization Flags for Fetch Object (Section 10.4.4)
 *
 * Table 7: Subgroup ID encoding (bits 0-1)
 * | Bitmask (flags & 0x03) | Meaning |
 * | 0x00 | Subgroup ID is zero |
 * | 0x01 | Subgroup ID is prior Object's Subgroup ID |
 * | 0x02 | Subgroup ID is prior Object's Subgroup ID + 1 |
 * | 0x03 | Subgroup ID field is present |
 *
 * Table 8: Additional flags
 * | Bitmask | Condition if set |
 * | 0x04 | Object ID field is present (else prior + 1) |
 * | 0x08 | Group ID field is present (else prior Group ID) |
 * | 0x10 | Priority field is present (else prior Priority) |
 * | 0x20 | Extensions field is present |
 * | 0x40 | Datagram: Subgroup ID の 2 ビットを無視 |
 *
 * End of Range (Section 10.4.4.2):
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
   * End of Non-Existent Range (Section 10.4.4.2)
   *
   * draft-ietf-moq-transport-17:
   * 指定した Location までの Object が存在しないことを示す。
   * Group ID と Object ID フィールドが存在する。
   * Subgroup ID, Priority, Properties は存在しない。
   * https://github.com/moq-wg/moq-transport/pull/1513
   */
  END_OF_NON_EXISTENT_RANGE: 0x8c,
  /**
   * End of Unknown Range (Section 10.4.4.2)
   *
   * draft-ietf-moq-transport-17:
   * 指定した Location までの Object のステータスが不明であることを示す。
   * Group ID と Object ID フィールドが存在する。
   * Subgroup ID, Priority, Properties は存在しない。
   * https://github.com/moq-wg/moq-transport/pull/1513
   */
  END_OF_UNKNOWN_RANGE: 0x10c,
} as const;

/**
 * Fetch Object Fields (Figure 31 in Section 10.4.4)
 */
// draft-ietf-moq-transport-17 Section 10.2.1.1:
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
 * draft-ietf-moq-transport-17 Section 10.4.4.2:
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
   * End of Range indicator (Section 10.4.4.2)
   *
   * draft-ietf-moq-transport-17:
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
 * draft-ietf-moq-transport-16 Section 10.4.4 Figure 31
 *
 * リレーサーバー実装用。moqt-js はクライアント専用のため、ランタイムでは使用しない。
 * PBT（Property-Based Testing）でのラウンドトリップテストで使用。
 */
export function encodeFetchObjectFields(
  fields: FetchObjectFields,
  includePayload = false,
): Uint8Array {
  const parts: Uint8Array[] = [];

  // Serialization Flags (varint)
  // draft-ietf-moq-transport-17: vi64 としてエンコード
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

  // Group ID (if flag 0x08 is set)
  if (fields.serializationFlags & FetchSerializationFlags.GROUP_ID_PRESENT) {
    if (fields.groupId === undefined) {
      throw new Error("Group ID required when GROUP_ID_PRESENT flag is set");
    }
    parts.push(encodeVarint(fields.groupId));
  }

  // Subgroup ID (if flags & 0x03 == 0x03)
  if (
    (fields.serializationFlags & FetchSerializationFlags.SUBGROUP_MASK) ===
    FetchSerializationFlags.SUBGROUP_PRESENT
  ) {
    if (fields.subgroupId === undefined) {
      throw new Error("Subgroup ID required when SUBGROUP_PRESENT is set");
    }
    parts.push(encodeVarint(fields.subgroupId));
  }

  // Object ID (if flag 0x04 is set)
  if (fields.serializationFlags & FetchSerializationFlags.OBJECT_ID_PRESENT) {
    if (fields.objectId === undefined) {
      throw new Error("Object ID required when OBJECT_ID_PRESENT flag is set");
    }
    parts.push(encodeVarint(fields.objectId));
  }

  // Publisher Priority (if flag 0x10 is set)
  if (fields.serializationFlags & FetchSerializationFlags.PRIORITY_PRESENT) {
    if (fields.publisherPriority === undefined) {
      throw new Error("Publisher Priority required when PRIORITY_PRESENT flag is set");
    }
    parts.push(new Uint8Array([fields.publisherPriority]));
  }

  // Extensions (if flag 0x20 is set)
  if (fields.serializationFlags & FetchSerializationFlags.PROPERTIES_PRESENT) {
    const extLen = fields.properties?.length ?? 0;
    parts.push(encodeVarint(extLen));
    if (fields.properties && fields.properties.length > 0) {
      parts.push(fields.properties);
    }
  }

  // Object Payload Length
  parts.push(encodeVarint(fields.payloadLength));

  // draft-ietf-moq-transport-17 Section 10.2.1.1:
  // "The Object Status is a field that is only present in objects that are
  // delivered via a SUBSCRIPTION, and is absent in Objects delivered via a FETCH."
  // Fetch Object には Object Status を含めない

  // Object Payload (optional, included when specified)
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
 * Decode Fetch Object Fields
 * draft-ietf-moq-transport-17 Section 10.4.4 Figure 27
 *
 * @param data - Data buffer
 * @param context - Context with prior object's values (required after first object)
 * @param offset - Starting offset in buffer
 * @param isFirst - Whether this is the first object (no prior context allowed)
 */
export function decodeFetchObjectFields(
  data: Uint8Array,
  context: FetchObjectContext | null,
  offset = 0,
  isFirst = false,
): [DecodedFetchObject, number, FetchObjectContext] {
  let totalConsumed = 0;

  // Serialization Flags (varint)
  // draft-ietf-moq-transport-17: vi64 としてエンコードされる
  const [flagsRaw, flagsConsumed] = decodeVarint(data, offset + totalConsumed);
  const flags = Number(flagsRaw);
  totalConsumed += flagsConsumed;

  // End of Range チェック (Section 10.4.4.2)
  if (
    flags === FetchSerializationFlags.END_OF_NON_EXISTENT_RANGE ||
    flags === FetchSerializationFlags.END_OF_UNKNOWN_RANGE
  ) {
    // End of Range: Group ID と Object ID のみが存在
    const [groupId, gidConsumed] = decodeVarint(data, offset + totalConsumed);
    totalConsumed += gidConsumed;

    const [objectId, oidConsumed] = decodeVarint(data, offset + totalConsumed);
    totalConsumed += oidConsumed;

    // Object Payload Length (0 であるべき)
    const [payloadLength, payloadLenConsumed] = decodeVarint(data, offset + totalConsumed);
    totalConsumed += payloadLenConsumed;

    const endOfRange: EndOfRangeType =
      flags === FetchSerializationFlags.END_OF_NON_EXISTENT_RANGE ? "non_existent" : "unknown";

    // prior context の更新:
    // Group ID と Object ID は End of Range の値を使用
    // Subgroup ID と Priority は直前の実 Object の値を維持
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
      totalConsumed,
      newContext,
    ];
  }

  // Group ID
  let groupId: bigint;
  if (flags & FetchSerializationFlags.GROUP_ID_PRESENT) {
    const [gid, gidConsumed] = decodeVarint(data, offset + totalConsumed);
    groupId = gid;
    totalConsumed += gidConsumed;
  } else {
    if (isFirst || context === null) {
      throw new Error("Protocol violation: First object must have GROUP_ID_PRESENT flag set");
    }
    groupId = context.groupId;
  }

  // Subgroup ID
  let subgroupId: bigint;
  const subgroupEncoding = flags & FetchSerializationFlags.SUBGROUP_MASK;
  switch (subgroupEncoding) {
    case FetchSerializationFlags.SUBGROUP_ZERO:
      subgroupId = 0n;
      break;
    case FetchSerializationFlags.SUBGROUP_SAME:
      if (isFirst || context === null) {
        throw new Error("Protocol violation: First object cannot use SUBGROUP_SAME");
      }
      subgroupId = context.subgroupId;
      break;
    case FetchSerializationFlags.SUBGROUP_PLUS_ONE:
      if (isFirst || context === null) {
        throw new Error("Protocol violation: First object cannot use SUBGROUP_PLUS_ONE");
      }
      subgroupId = context.subgroupId + 1n;
      break;
    case FetchSerializationFlags.SUBGROUP_PRESENT: {
      const [sid, sidConsumed] = decodeVarint(data, offset + totalConsumed);
      subgroupId = sid;
      totalConsumed += sidConsumed;
      break;
    }
    default:
      throw new Error(`Invalid subgroup encoding: ${subgroupEncoding}`);
  }

  // Object ID
  let objectId: bigint;
  if (flags & FetchSerializationFlags.OBJECT_ID_PRESENT) {
    const [oid, oidConsumed] = decodeVarint(data, offset + totalConsumed);
    objectId = oid;
    totalConsumed += oidConsumed;
  } else {
    if (isFirst || context === null) {
      throw new Error("Protocol violation: First object must have OBJECT_ID_PRESENT flag set");
    }
    objectId = context.objectId + 1n;
  }

  // Publisher Priority
  let publisherPriority: number;
  if (flags & FetchSerializationFlags.PRIORITY_PRESENT) {
    publisherPriority = data[offset + totalConsumed];
    totalConsumed += 1;

    // draft-ietf-moq-transport-16:
    // 同一 Subgroup 内のオブジェクトは同じ Priority を持つ必要がある。
    // 異なる Priority を検出した場合は MALFORMED_TRACK エラー。
    // https://github.com/moq-wg/moq-transport/pull/1317
    if (context !== null && subgroupId === context.subgroupId) {
      if (publisherPriority !== context.publisherPriority) {
        throw new Error(
          `malformed track: different priorities in same subgroup ` +
            `(subgroup=${subgroupId}, expected=${context.publisherPriority}, actual=${publisherPriority})`,
        );
      }
    }
  } else {
    if (isFirst || context === null) {
      throw new Error("Protocol violation: First object must have PRIORITY_PRESENT flag set");
    }
    publisherPriority = context.publisherPriority;
  }

  // Extensions
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

  // draft-ietf-moq-transport-17 Section 10.2.1.1:
  // "The Object Status is a field that is only present in objects that are
  // delivered via a SUBSCRIPTION, and is absent in Objects delivered via a FETCH."
  // Fetch Object には Object Status は存在しない

  // Update context for next object
  const newContext: FetchObjectContext = {
    groupId,
    subgroupId,
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
 */
export function createFirstFetchObjectFlags(hasExtensions = false): number {
  let flags =
    FetchSerializationFlags.GROUP_ID_PRESENT |
    FetchSerializationFlags.SUBGROUP_PRESENT |
    FetchSerializationFlags.OBJECT_ID_PRESENT |
    FetchSerializationFlags.PRIORITY_PRESENT;

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

  // Extensions
  if (hasExtensions) {
    flags |= FetchSerializationFlags.PROPERTIES_PRESENT;
  }

  return flags;
}
