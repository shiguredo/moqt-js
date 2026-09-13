/**
 * MOQT Object Datagram
 * draft-ietf-moq-transport-21 Section 11.2 (Object Datagrams)
 *
 * Object Datagram (Section 11.2.1) のエンコードとデコードを扱う。
 * Subgroup と異なり 1 オブジェクトが 1 datagram に収まり、Type Flags で
 * Object ID / Priority / Properties / Status の有無が決まる。
 */

import { decodeVarint, encodeVarint } from "../varint";
import { ObjectStatus } from "../message/types";
import { IncompleteDataError, ProtocolViolationError } from "../error";
import {
  assertKnownPropertyValueInObjectProperties,
  assertNoMandatoryTrackPropertyInObjectProperties,
  assertPriorIdGapInObjectProperties,
} from "../properties";
import { concatUint8Arrays } from "../bytes";
import {
  ERR_PUBLISHER_PRIORITY_REQUIRED,
  validateObjectStatus,
  validatePublisherPriority,
} from "./common";

/**
 * Object Datagram Type Flags (Section 11.2.1)
 *
 * draft-ietf-moq-transport-21 Section 11.2.1 (Appendix A.2 #1774 で
 * Type Flags bitfield として記述):
 * Type Flags はフラグ集合を表す可変長整数であり、定義値は 1 バイト
 * (128 未満) に収まる (PROPERTIES 0x01 / END_OF_GROUP 0x02 /
 * ZERO_OBJECT_ID 0x04 / DEFAULT_PRIORITY 0x08 / STATUS 0x20)。
 * bit 4 (0x10) が立つ値や、意味の無いビットが立つ値は
 * PROTOCOL_VIOLATION で拒否する。
 *
 * Section 11.2.1 (Object Datagram) / Figure 24 from draft-ietf-moq-transport-21:
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
  // ペイロードタイプ、Object ID あり、Priority Present (Section 11.2.1: 0x00-0x03)
  PAYLOAD_OBJ: 0x00,
  PAYLOAD_OBJ_EXT: 0x01,
  PAYLOAD_OBJ_END_GROUP: 0x02,
  PAYLOAD_OBJ_EXT_END_GROUP: 0x03,

  // ペイロードタイプ、Object ID なし (Object ID = 0)、Priority Present (Section 11.2.1: 0x04-0x07)
  PAYLOAD_NO_OBJ: 0x04,
  PAYLOAD_NO_OBJ_EXT: 0x05,
  PAYLOAD_NO_OBJ_END_GROUP: 0x06,
  PAYLOAD_NO_OBJ_EXT_END_GROUP: 0x07,

  // ペイロードタイプ、Object ID あり、Priority なし (Section 11.2.1: 0x08-0x0B)
  PAYLOAD_OBJ_NO_PRI: 0x08,
  PAYLOAD_OBJ_EXT_NO_PRI: 0x09,
  PAYLOAD_OBJ_END_GROUP_NO_PRI: 0x0a,
  PAYLOAD_OBJ_EXT_END_GROUP_NO_PRI: 0x0b,

  // ペイロードタイプ、Object ID なし、Priority なし (Section 11.2.1: 0x0C-0x0F)
  PAYLOAD_NO_OBJ_NO_PRI: 0x0c,
  PAYLOAD_NO_OBJ_EXT_NO_PRI: 0x0d,
  PAYLOAD_NO_OBJ_END_GROUP_NO_PRI: 0x0e,
  PAYLOAD_NO_OBJ_EXT_END_GROUP_NO_PRI: 0x0f,

  // ステータスタイプ、Object ID あり、Priority Present (Section 11.2.1: 0x20-0x21)
  STATUS_OBJ: 0x20,
  STATUS_OBJ_EXT: 0x21,

  // ステータスタイプ、Object ID なし、Priority Present (Section 11.2.1: 0x24-0x25)
  STATUS_NO_OBJ: 0x24,
  STATUS_NO_OBJ_EXT: 0x25,

  // ステータスタイプ、Object ID あり、Priority なし (Section 11.2.1: 0x28-0x29)
  STATUS_OBJ_NO_PRI: 0x28,
  STATUS_OBJ_EXT_NO_PRI: 0x29,

  // ステータスタイプ、Object ID なし (Object ID = 0)、Priority なし (Section 11.2.1: 0x2C-0x2D)
  // draft-ietf-moq-transport-21 Section 11.2.1:
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
  /**
   * Publisher Priority。Priority Present のない datagram では undefined
   * (draft-ietf-moq-transport-21 Section 11.2.1: 0x08-0x0F, 0x28-0x2D は
   * Priority なし)。デコード時点では 0 のダミー値を入れず、受信経路
   * (SubscriberImpl) が購読の DEFAULT_PUBLISHER_PRIORITY (省略時 128) を
   * 継承させてから PRIORITY_FILTER を評価する (§10.4)。
   */
  publisherPriority?: number;
  properties?: Uint8Array;
  status?: ObjectStatus;
  payload?: Uint8Array;
}

/**
 * Object ID フィールドの有無を判定する
 *
 * draft-ietf-moq-transport-21 Section 11.2.1:
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
 * draft-ietf-moq-transport-21 Section 11.2.1 (Object Datagram):
 * Types 0x00-0x07 and 0x20-0x25 have Priority Present = Yes
 * Types 0x08-0x0F and 0x28-0x2D have Priority Present = No
 */
function datagramHasPriority(type: number): boolean {
  // タイプ 0x00-0x07 は Priority あり (Section 11.2.1)
  if (type <= 0x07) {
    return true;
  }
  // タイプ 0x08-0x0F は Priority なし (Section 11.2.1)
  if (type >= 0x08 && type <= 0x0f) {
    return false;
  }
  // タイプ 0x20-0x25 は Priority あり (Section 11.2.1)
  if (type >= 0x20 && type <= 0x25) {
    return true;
  }
  // タイプ 0x28-0x2D は Priority なし (Section 11.2.1)
  return false;
}

/**
 * Encode an Object Datagram
 * draft-ietf-moq-transport-21 Section 11.2.1
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

  // Priority Present の有無を判定 (Section 11.2.1: 0x08-0x0F, 0x28-0x2D は Priority なし)
  if (datagramHasPriority(datagram.type)) {
    // Priority Present ありの場合は publisherPriority が必須 (encodeObjectDatagram
    // の入力はアプリが指定するため)
    if (datagram.publisherPriority === undefined) {
      throw new Error(ERR_PUBLISHER_PRIORITY_REQUIRED);
    }
    validatePublisherPriority(datagram.publisherPriority);
    parts.push(new Uint8Array([datagram.publisherPriority]));
  }

  if (datagramHasProperties(datagram.type)) {
    const extLen = datagram.properties?.length ?? 0;

    // draft-ietf-moq-transport-21 Section 11.1.3:
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

  return concatUint8Arrays(parts);
}

/**
 * Object Datagram の先頭固定フィールド (Type Flags → Track Alias) を読む
 *
 * draft-ietf-moq-transport-21 Section 11.2.1:
 * Type Flags と Track Alias は Datagram の先頭に固定配置される。
 *
 * この配置知識を 1 箇所に集約する。`decodeObjectDatagram` の本体と、
 * デコード失敗時に cancel 対象を引くための Track Alias の取り出し
 * (`decodeDatagramTrackAlias`) が同じ実装を共有する。片方だけがワイヤ配置を
 * 変わると、誤った alias を引いて無関係な購読を cancel し得る。
 *
 * @param data - Datagram のバイト列
 * @param offset - 読み取り開始位置
 * @returns Type Flags (数値) と Track Alias、消費したバイト数
 */
export function decodeDatagramTypeAndTrackAlias(
  data: Uint8Array,
  offset = 0,
): { type: number; trackAlias: bigint; consumed: number } {
  const [type, typeConsumed] = decodeVarint(data, offset);

  const typeNum = Number(type);

  // draft-ietf-moq-transport-21 Section 11.2.1:
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

  const [trackAlias, trackAliasConsumed] = decodeVarint(data, offset + typeConsumed);

  return { type: typeNum, trackAlias, consumed: typeConsumed + trackAliasConsumed };
}

/**
 * Decode an Object Datagram
 * draft-ietf-moq-transport-21 Section 11.2.1
 */
export function decodeObjectDatagram(data: Uint8Array, offset = 0): [ObjectDatagram, number] {
  const head = decodeDatagramTypeAndTrackAlias(data, offset);
  const typeNum = head.type;
  const trackAlias = head.trackAlias;
  let totalConsumed = head.consumed;

  const [groupId, groupIdConsumed] = decodeVarint(data, offset + totalConsumed);
  totalConsumed += groupIdConsumed;

  let objectId = 0n;
  if (datagramHasObjectId(typeNum)) {
    const [oid, oidConsumed] = decodeVarint(data, offset + totalConsumed);
    objectId = oid;
    totalConsumed += oidConsumed;
  }

  // Priority Present の有無を判定 (Section 11.2.1: 0x08-0x0F, 0x28-0x2D は Priority なし)
  // Priority が明示されていない場合は undefined を設定する。0 のダミー値は
  // 入れず、受信経路 (SubscriberImpl) が購読の DEFAULT_PUBLISHER_PRIORITY
  // (省略時 128) を継承させてから PRIORITY_FILTER を評価する (§10.4)。
  let publisherPriority: number | undefined;
  if (datagramHasPriority(typeNum)) {
    // Priority は 8 bit 固定のため、バッファが Priority バイトで切れている
    // 場合は範囲外アクセス (undefined 取得) による誤配信を避け、
    // IncompleteDataError を throw する (subgroup ヘッダーと同方式)。
    // 受信側 (incomingHandleDatagram) は IncompleteDataError を
    // toProtocolViolationSessionError で PROTOCOL_VIOLATION に変換して
    // セッションを閉じる (長さ検証後の構造破損 = プロトコル違反の
    // リポジトリ共通解釈。既存の varint 不足と同じ扱い)。
    if (offset + totalConsumed >= data.length) {
      throw new IncompleteDataError("incomplete datagram: publisher priority");
    }
    publisherPriority = data[offset + totalConsumed];
    totalConsumed += 1;
  }

  let properties: Uint8Array | undefined;
  let propertiesLength = 0;
  if (datagramHasProperties(typeNum)) {
    const [extLen, extLenConsumed] = decodeVarint(data, offset + totalConsumed);
    propertiesLength = Number(extLen);
    totalConsumed += extLenConsumed;

    // draft-ietf-moq-transport-21 Section 11.2.1:
    // "If an endpoint receives a datagram with the PROPERTIES bit set and
    //  an Properties Length of 0, it MUST close the session with a
    //  PROTOCOL_VIOLATION."
    if (propertiesLength === 0) {
      throw new ProtocolViolationError(
        "datagram has PROPERTIES bit set but Properties Length is 0",
      );
    }

    // Properties 本体が宣言バイト数に満たない場合は切り詰めた不正 datagram を
    // 配信せず IncompleteDataError を throw する (decodeSubgroupHeader の
    // Priority バイト境界チェックと同方式)。
    // 受信側 (incomingHandleDatagram) は IncompleteDataError を
    // toProtocolViolationSessionError で PROTOCOL_VIOLATION に変換して
    // セッションを閉じる (長さ検証後の構造破損 = プロトコル違反の
    // リポジトリ共通解釈。既存の varint 不足と同じ扱い)。
    if (offset + totalConsumed + propertiesLength > data.length) {
      throw new IncompleteDataError("incomplete datagram: properties");
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

    // draft-ietf-moq-transport-21 Section 11.1.3:
    // "Any Object with status Normal can have properties (Section 8.4).
    // If an endpoint receives properties on an Object with status
    // that is not Normal, it MUST close the session with a PROTOCOL_VIOLATION."
    if (status !== ObjectStatus.NORMAL && propertiesLength > 0) {
      throw new ProtocolViolationError("properties on non-Normal status object");
    }
  } else {
    payload = data.slice(offset + totalConsumed);
    totalConsumed = data.length - offset;
  }

  // draft-ietf-moq-transport-21 §3.6:
  // Mandatory Track Property を Object Property として含む Object は malformed
  // (non-Normal status の properties 検証より後に判定する)
  if (properties !== undefined) {
    assertNoMandatoryTrackPropertyInObjectProperties(properties);
    // draft-ietf-moq-transport-21 §8.3:
    // 既知 Type の Value が serialization に一致しない場合は
    // KEY_VALUE_FORMATTING_ERROR でセッションを閉じる
    assertKnownPropertyValueInObjectProperties(properties);
  }

  // draft-ietf-moq-transport-21 §10.8 / §10.9:
  // Prior Group ID Gap / Prior Object ID Gap のうち単一 Object で判定できる
  // malformed 条件 (gap が Group ID / Object ID より大きい) を検証する。
  assertPriorIdGapInObjectProperties(groupId, objectId, properties);

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
