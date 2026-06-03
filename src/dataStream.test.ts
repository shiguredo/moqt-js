import { test, assert } from "vite-plus/test";
import {
  SubgroupHeaderType,
  encodeSubgroupHeader,
  decodeSubgroupHeader,
  encodeObjectFields,
  decodeObjectFields,
  hasPropertiesPresent,
  hasContainsEndOfGroup,
  createObject,
  DatagramType,
  type ObjectDatagram,
  encodeObjectDatagram,
  decodeObjectDatagram,
  FetchHeaderType,
  type FetchHeader,
  encodeFetchHeader,
  decodeFetchHeader,
  FetchSerializationFlags,
  type FetchObjectFields,
  type FetchObjectContext,
  encodeFetchObjectFields,
  decodeFetchObjectFields,
  createFirstFetchObjectFlags,
  createFetchObjectFlags,
} from "./dataStream";
import { ObjectStatus } from "./message/types";
import { GroupOrder } from "./message/types";
import { encodeVarint } from "./varint";
import { IncompleteDataError, ProtocolViolationError } from "./error";

test("SubgroupHeader: BASE タイプ (0x10) をエンコード", () => {
  const header = {
    type: SubgroupHeaderType.BASE,
    trackAlias: 5n,
    groupId: 10n,
    publisherPriority: 128,
  };

  const encoded = encodeSubgroupHeader(header);

  assert.equal(encoded.length, 4);
  assert.equal(encoded[0], 0x10);
  assert.equal(encoded[1], 5);
  assert.equal(encoded[2], 10);
  assert.equal(encoded[3], 128);
});

test("SubgroupHeader: EXPLICIT タイプ (0x14) - SubgroupId ありをエンコード", () => {
  const header = {
    type: SubgroupHeaderType.EXPLICIT,
    trackAlias: 3n,
    groupId: 7n,
    subgroupId: 2n,
    publisherPriority: 200,
  };

  const encoded = encodeSubgroupHeader(header);

  assert.equal(encoded.length, 5);
  assert.equal(encoded[0], 0x14);
  assert.equal(encoded[1], 3);
  assert.equal(encoded[2], 7);
  assert.equal(encoded[3], 2);
  assert.equal(encoded[4], 200);
});

test("SubgroupHeader: 大きな値をエンコード", () => {
  const header = {
    type: SubgroupHeaderType.BASE,
    trackAlias: 1000n,
    groupId: 2000n,
    publisherPriority: 255,
  };

  const encoded = encodeSubgroupHeader(header);

  assert.isAbove(encoded.length, 4);
});

test("SubgroupHeader: Priority なしをエンコード", () => {
  const header = {
    type: SubgroupHeaderType.BASE,
    trackAlias: 1n,
    groupId: 1n,
  };

  const encoded = encodeSubgroupHeader(header);

  assert.equal(encoded.length, 3);
});

test("SubgroupHeader: BASE タイプをデコード", () => {
  const data = new Uint8Array([0x10, 0x05, 0x0a, 0x80]);
  const [header, consumed] = decodeSubgroupHeader(data);

  assert.equal(header.type, SubgroupHeaderType.BASE);
  assert.equal(header.trackAlias, 5n);
  assert.equal(header.groupId, 10n);
  assert.equal(header.subgroupId, 0n);
  assert.equal(header.publisherPriority, 128);
  assert.equal(consumed, 4);
});

test("SubgroupHeader: EXPLICIT タイプをデコード", () => {
  const data = new Uint8Array([0x14, 0x03, 0x07, 0x02, 0xc8]);
  const [header, consumed] = decodeSubgroupHeader(data);

  assert.equal(header.type, SubgroupHeaderType.EXPLICIT);
  assert.equal(header.trackAlias, 3n);
  assert.equal(header.groupId, 7n);
  assert.equal(header.subgroupId, 2n);
  assert.equal(header.publisherPriority, 200);
  assert.equal(consumed, 5);
});

test("SubgroupHeader: オフセット付きでデコード", () => {
  const data = new Uint8Array([0xff, 0xff, 0x10, 0x01, 0x02, 0x80]);
  const [header, consumed] = decodeSubgroupHeader(data, 2);

  assert.equal(header.type, SubgroupHeaderType.BASE);
  assert.equal(header.trackAlias, 1n);
  assert.equal(header.groupId, 2n);
  assert.equal(consumed, 4);
});

// draft-ietf-moq-transport-18 Section 11.4.2:
// SUBGROUP_ID_MODE = 0b11 のタイプ値は予約済みであり、受信側は PROTOCOL_VIOLATION で
// セッションを閉じなければならない
for (const reservedType of [0x16, 0x17, 0x1e, 0x1f, 0x36, 0x37, 0x3e, 0x3f]) {
  test(`SubgroupHeader: 予約値 0x${reservedType.toString(16)} は ProtocolViolationError`, () => {
    const data = new Uint8Array([reservedType, 0x01, 0x02, 0x80]);
    assert.throws(() => decodeSubgroupHeader(data), ProtocolViolationError);
    assert.throws(() => decodeSubgroupHeader(data), /SUBGROUP_ID_MODE 0b11 is reserved/);
  });
}

test("SubgroupHeader: バッファ不足は IncompleteDataError", () => {
  // 空のバッファを decode に渡すとデータ不足
  const data = new Uint8Array(0);
  assert.throws(() => decodeSubgroupHeader(data), IncompleteDataError);
});

test("SubgroupHeader: 途中までのバッファは IncompleteDataError", () => {
  // type のみで他のフィールドが揃っていない
  const data = new Uint8Array([0x10]);
  assert.throws(() => decodeSubgroupHeader(data), IncompleteDataError);
});

// draft-ietf-moq-transport-18 Section 11.4.2:
// 0b0XX1XXXX の形式に合わない値 (bit 4 が立っていない) は不正
for (const invalidType of [0x00, 0x01, 0x02, 0x05, 0x20, 0x40]) {
  test(`SubgroupHeader: 不正タイプ 0x${invalidType.toString(16)} は decode でエラー`, () => {
    const data = new Uint8Array([invalidType, 0x01, 0x02, 0x80]);
    assert.throws(() => decodeSubgroupHeader(data), /does not match form 0b0XX1XXXX/);
  });
}

const subgroupHeaderTestCases = [
  {
    name: "BASE タイプ",
    header: {
      type: SubgroupHeaderType.BASE,
      trackAlias: 10n,
      groupId: 20n,
      publisherPriority: 100,
    },
  },
  {
    name: "BASE_EXT タイプ",
    header: {
      type: SubgroupHeaderType.BASE_EXT,
      trackAlias: 0n,
      groupId: 0n,
      publisherPriority: 0,
    },
  },
  {
    name: "FIRST_OBJ タイプ",
    header: {
      type: SubgroupHeaderType.FIRST_OBJ,
      trackAlias: 10n,
      groupId: 20n,
      publisherPriority: 100,
    },
  },
  {
    name: "FIRST_OBJ_EXT タイプ",
    header: {
      type: SubgroupHeaderType.FIRST_OBJ_EXT,
      trackAlias: 10n,
      groupId: 20n,
      publisherPriority: 100,
    },
  },
  {
    name: "EXPLICIT タイプ with subgroupId",
    header: {
      type: SubgroupHeaderType.EXPLICIT,
      trackAlias: 50n,
      groupId: 100n,
      subgroupId: 5n,
      publisherPriority: 255,
    },
  },
  {
    name: "大きな値",
    header: {
      type: SubgroupHeaderType.BASE,
      trackAlias: 10000n,
      groupId: 20000n,
      publisherPriority: 128,
    },
  },
];

for (const tc of subgroupHeaderTestCases) {
  test(`SubgroupHeader roundtrip: ${tc.name}`, () => {
    const encoded = encodeSubgroupHeader(tc.header);
    const [decoded, consumed] = decodeSubgroupHeader(encoded);

    assert.equal(decoded.type, tc.header.type);
    assert.equal(decoded.trackAlias, tc.header.trackAlias);
    assert.equal(decoded.groupId, tc.header.groupId);
    if (tc.header.subgroupId !== undefined) {
      assert.equal(decoded.subgroupId, tc.header.subgroupId);
    }
    assert.equal(decoded.publisherPriority, tc.header.publisherPriority);
    assert.equal(consumed, encoded.length);
  });
}

test("SubgroupHeader: FIRST_OBJ タイプはデコード時に subgroupId が undefined になる", () => {
  // draft-ietf-moq-transport-18 Section 11.4.2:
  // Subgroup ID = First Object ID の場合、ヘッダーに Subgroup ID フィールドはなく、
  // 最初のオブジェクトの Object ID が Subgroup ID として使われる
  const header = {
    type: SubgroupHeaderType.FIRST_OBJ,
    trackAlias: 10n,
    groupId: 20n,
    publisherPriority: 100,
  };
  const encoded = encodeSubgroupHeader(header);
  const [decoded, consumed] = decodeSubgroupHeader(encoded);

  assert.equal(decoded.type, SubgroupHeaderType.FIRST_OBJ);
  assert.equal(decoded.trackAlias, 10n);
  assert.equal(decoded.groupId, 20n);
  assert.isUndefined(decoded.subgroupId);
  assert.equal(decoded.publisherPriority, 100);
  assert.equal(consumed, encoded.length);
});

test("hasPropertiesPresent: 偶数タイプは Properties Present = No", () => {
  assert.equal(hasPropertiesPresent(0x10), false);
  assert.equal(hasPropertiesPresent(0x12), false);
  assert.equal(hasPropertiesPresent(0x14), false);
});

test("hasPropertiesPresent: 奇数タイプは Properties Present = Yes", () => {
  assert.equal(hasPropertiesPresent(0x11), true);
  assert.equal(hasPropertiesPresent(0x13), true);
  assert.equal(hasPropertiesPresent(0x15), true);
});

test("ObjectFields: Properties なしタイプ (0x10) をエンコード", () => {
  const encoded = encodeObjectFields(1n, 50n, 0x10);

  assert.equal(encoded[0], 1);
  assert.equal(encoded[1], 50);
  assert.equal(encoded.length, 2);
});

test("ObjectFields: Properties ありタイプ (0x11) をエンコード", () => {
  const encoded = encodeObjectFields(1n, 50n, 0x11);

  assert.equal(encoded[0], 1);
  assert.equal(encoded[1], 0);
  assert.equal(encoded[2], 50);
  assert.equal(encoded.length, 3);
});

test("ObjectFields: ステータス付き (payload length = 0) をエンコード", () => {
  const encoded = encodeObjectFields(5n, 0n, 0x10, ObjectStatus.END_OF_GROUP);

  assert.equal(encoded[0], 5);
  assert.equal(encoded[1], 0);
  assert.equal(encoded[2], ObjectStatus.END_OF_GROUP);
  assert.equal(encoded.length, 3);
});

test("ObjectFields: Properties データ付き (0x11 タイプ) をエンコード", () => {
  const properties = new Uint8Array([0xaa, 0xbb, 0xcc]);
  const encoded = encodeObjectFields(10n, 50n, 0x11, ObjectStatus.NORMAL, properties);

  assert.equal(encoded[0], 10);
  assert.equal(encoded[1], 3);
  assert.deepEqual(encoded.slice(2, 5), properties);
  assert.equal(encoded[5], 50);
});

test("ObjectFields: 大きな objectIdDelta と payloadLength をエンコード", () => {
  const encoded = encodeObjectFields(10000n, 100000n, 0x10);

  assert.isAbove(encoded.length, 2);
});

test("ObjectFields: Properties なしタイプ (0x10) をデコード", () => {
  const data = new Uint8Array([0x01, 0x3f]);
  const [fields, consumed] = decodeObjectFields(data, 0x10);

  assert.equal(fields.objectIdDelta, 1n);
  assert.equal(fields.propertiesLength, 0);
  assert.equal(fields.payloadLength, 63n);
  assert.equal(consumed, 2);
});

test("ObjectFields: Properties ありタイプ (0x11) をデコード", () => {
  const data = new Uint8Array([0x05, 0x03, 0xaa, 0xbb, 0xcc, 0x0a]);
  const [fields, consumed] = decodeObjectFields(data, 0x11);

  assert.equal(fields.objectIdDelta, 5n);
  assert.equal(fields.propertiesLength, 3);
  assert.deepEqual(fields.properties, new Uint8Array([0xaa, 0xbb, 0xcc]));
  assert.equal(fields.payloadLength, 10n);
  assert.equal(consumed, 6);
});

test("ObjectFields: オフセット付きでデコード", () => {
  const data = new Uint8Array([0xff, 0xff, 0x0a, 0x14]);
  const [fields, consumed] = decodeObjectFields(data, 0x10, 2);

  assert.equal(fields.objectIdDelta, 10n);
  assert.equal(fields.payloadLength, 20n);
  assert.equal(consumed, 2);
});

const objectFieldsTestCases = [
  { objectIdDelta: 0n, payloadLength: 0n, headerType: 0x10 },
  { objectIdDelta: 1n, payloadLength: 100n, headerType: 0x10 },
  { objectIdDelta: 100n, payloadLength: 1000n, headerType: 0x10 },
  { objectIdDelta: 10000n, payloadLength: 100000n, headerType: 0x10 },
];

for (const tc of objectFieldsTestCases) {
  test(`ObjectFields roundtrip: delta=${tc.objectIdDelta}, payloadLen=${tc.payloadLength}`, () => {
    const encoded = encodeObjectFields(tc.objectIdDelta, tc.payloadLength, tc.headerType);
    const [decoded, consumed] = decodeObjectFields(encoded, tc.headerType);

    assert.equal(decoded.objectIdDelta, tc.objectIdDelta);
    assert.equal(decoded.payloadLength, tc.payloadLength);
    assert.equal(consumed, encoded.length);
  });
}

test("ObjectFields: Properties 付き roundtrip (0x11 タイプ)", () => {
  const properties = new Uint8Array([0x11, 0x22, 0x33, 0x44, 0x55]);
  const encoded = encodeObjectFields(42n, 256n, 0x11, ObjectStatus.NORMAL, properties);
  const [decoded, consumed] = decodeObjectFields(encoded, 0x11);

  assert.equal(decoded.objectIdDelta, 42n);
  assert.equal(decoded.propertiesLength, 5);
  assert.deepEqual(decoded.properties, properties);
  assert.equal(consumed, encoded.length);
});

test("createObject: 基本的な MoqtObject を作成", () => {
  const payload = new Uint8Array([0x01, 0x02, 0x03]);
  const obj = createObject(1n, 2n, payload);

  assert.equal(obj.groupId, 1n);
  assert.equal(obj.objectId, 2n);
  assert.deepEqual(obj.payload, payload);
  assert.equal(obj.status, ObjectStatus.NORMAL);
  assert.isUndefined(obj.subgroupId);
  assert.isUndefined(obj.publisherPriority);
});

test("createObject: オプション付きで作成", () => {
  const payload = new Uint8Array([0xaa, 0xbb]);
  const obj = createObject(10n, 20n, payload, {
    subgroupId: 5n,
    publisherPriority: 200,
  });

  assert.equal(obj.groupId, 10n);
  assert.equal(obj.objectId, 20n);
  assert.equal(obj.subgroupId, 5n);
  assert.equal(obj.publisherPriority, 200);
  assert.equal(obj.status, ObjectStatus.NORMAL);
});

test("createObject: 空ペイロードで作成", () => {
  const obj = createObject(0n, 0n, new Uint8Array(0));

  assert.equal(obj.payload.length, 0);
  assert.equal(obj.status, ObjectStatus.NORMAL);
});

/**
 * draft-ietf-moq-transport-18:
 * OBJECT_DOES_NOT_EXIST (0x1) は削除された。
 * draft-ietf-moq-transport-18 Section 11.2.1.1
 */
test("ObjectStatus: すべてのステータス値が定義されている", () => {
  assert.equal(ObjectStatus.NORMAL, 0x0);
  assert.equal(ObjectStatus.END_OF_GROUP, 0x3);
  assert.equal(ObjectStatus.END_OF_TRACK, 0x4);
});

test("SubgroupHeaderType: すべての 24 タイプ値が定義されている", () => {
  assert.equal(SubgroupHeaderType.BASE, 0x10);
  assert.equal(SubgroupHeaderType.BASE_EXT, 0x11);
  assert.equal(SubgroupHeaderType.FIRST_OBJ, 0x12);
  assert.equal(SubgroupHeaderType.FIRST_OBJ_EXT, 0x13);
  assert.equal(SubgroupHeaderType.EXPLICIT, 0x14);
  assert.equal(SubgroupHeaderType.EXPLICIT_EXT, 0x15);

  assert.equal(SubgroupHeaderType.BASE_END_GROUP, 0x18);
  assert.equal(SubgroupHeaderType.BASE_EXT_END_GROUP, 0x19);
  assert.equal(SubgroupHeaderType.FIRST_OBJ_END_GROUP, 0x1a);
  assert.equal(SubgroupHeaderType.FIRST_OBJ_EXT_END_GROUP, 0x1b);
  assert.equal(SubgroupHeaderType.EXPLICIT_END_GROUP, 0x1c);
  assert.equal(SubgroupHeaderType.EXPLICIT_EXT_END_GROUP, 0x1d);

  assert.equal(SubgroupHeaderType.BASE_NO_PRIORITY, 0x30);
  assert.equal(SubgroupHeaderType.BASE_EXT_NO_PRIORITY, 0x31);
  assert.equal(SubgroupHeaderType.FIRST_OBJ_NO_PRIORITY, 0x32);
  assert.equal(SubgroupHeaderType.FIRST_OBJ_EXT_NO_PRIORITY, 0x33);
  assert.equal(SubgroupHeaderType.EXPLICIT_NO_PRIORITY, 0x34);
  assert.equal(SubgroupHeaderType.EXPLICIT_EXT_NO_PRIORITY, 0x35);

  assert.equal(SubgroupHeaderType.BASE_END_GROUP_NO_PRIORITY, 0x38);
  assert.equal(SubgroupHeaderType.BASE_EXT_END_GROUP_NO_PRIORITY, 0x39);
  assert.equal(SubgroupHeaderType.FIRST_OBJ_END_GROUP_NO_PRIORITY, 0x3a);
  assert.equal(SubgroupHeaderType.FIRST_OBJ_EXT_END_GROUP_NO_PRIORITY, 0x3b);
  assert.equal(SubgroupHeaderType.EXPLICIT_END_GROUP_NO_PRIORITY, 0x3c);
  assert.equal(SubgroupHeaderType.EXPLICIT_EXT_END_GROUP_NO_PRIORITY, 0x3d);
});

test("SubgroupHeaderType: Priority Present フラグが正しく判定される", () => {
  assert.equal(hasPropertiesPresent(SubgroupHeaderType.BASE), false);
  assert.equal(hasPropertiesPresent(SubgroupHeaderType.BASE_EXT), true);
  assert.equal(hasPropertiesPresent(SubgroupHeaderType.BASE_END_GROUP), false);
  assert.equal(hasPropertiesPresent(SubgroupHeaderType.BASE_EXT_END_GROUP), true);

  assert.equal(hasPropertiesPresent(SubgroupHeaderType.BASE_NO_PRIORITY), false);
  assert.equal(hasPropertiesPresent(SubgroupHeaderType.BASE_EXT_NO_PRIORITY), true);
  assert.equal(hasPropertiesPresent(SubgroupHeaderType.BASE_END_GROUP_NO_PRIORITY), false);
  assert.equal(hasPropertiesPresent(SubgroupHeaderType.BASE_EXT_END_GROUP_NO_PRIORITY), true);
});

test("SubgroupHeaderType: Contains End of Group フラグが正しく判定される", () => {
  assert.equal(hasContainsEndOfGroup(SubgroupHeaderType.BASE), false);
  assert.equal(hasContainsEndOfGroup(SubgroupHeaderType.EXPLICIT), false);
  assert.equal(hasContainsEndOfGroup(SubgroupHeaderType.BASE_NO_PRIORITY), false);
  assert.equal(hasContainsEndOfGroup(SubgroupHeaderType.EXPLICIT_NO_PRIORITY), false);

  assert.equal(hasContainsEndOfGroup(SubgroupHeaderType.BASE_END_GROUP), true);
  assert.equal(hasContainsEndOfGroup(SubgroupHeaderType.EXPLICIT_END_GROUP), true);
  assert.equal(hasContainsEndOfGroup(SubgroupHeaderType.BASE_END_GROUP_NO_PRIORITY), true);
  assert.equal(hasContainsEndOfGroup(SubgroupHeaderType.EXPLICIT_END_GROUP_NO_PRIORITY), true);
});

test("SubgroupHeaderType: No Priority タイプの roundtrip テスト", () => {
  const header = {
    type: SubgroupHeaderType.BASE_NO_PRIORITY,
    trackAlias: 10n,
    groupId: 20n,
  };

  const encoded = encodeSubgroupHeader(header);
  const [decoded, consumed] = decodeSubgroupHeader(encoded);

  assert.equal(decoded.type, SubgroupHeaderType.BASE_NO_PRIORITY);
  assert.equal(decoded.trackAlias, 10n);
  assert.equal(decoded.groupId, 20n);
  assert.equal(decoded.subgroupId, 0n);
  assert.isUndefined(decoded.publisherPriority);
  assert.equal(consumed, encoded.length);
});

test("SubgroupHeaderType: End of Group タイプの roundtrip テスト", () => {
  const header = {
    type: SubgroupHeaderType.EXPLICIT_END_GROUP,
    trackAlias: 5n,
    groupId: 100n,
    subgroupId: 3n,
    publisherPriority: 64,
  };

  const encoded = encodeSubgroupHeader(header);
  const [decoded, consumed] = decodeSubgroupHeader(encoded);

  assert.equal(decoded.type, SubgroupHeaderType.EXPLICIT_END_GROUP);
  assert.equal(decoded.trackAlias, 5n);
  assert.equal(decoded.groupId, 100n);
  assert.equal(decoded.subgroupId, 3n);
  assert.equal(decoded.publisherPriority, 64);
  assert.equal(consumed, encoded.length);
});

test("SubgroupHeaderType: No Priority + End of Group タイプの roundtrip テスト", () => {
  const header = {
    type: SubgroupHeaderType.EXPLICIT_END_GROUP_NO_PRIORITY,
    trackAlias: 1n,
    groupId: 50n,
    subgroupId: 7n,
  };

  const encoded = encodeSubgroupHeader(header);
  const [decoded, consumed] = decodeSubgroupHeader(encoded);

  assert.equal(decoded.type, SubgroupHeaderType.EXPLICIT_END_GROUP_NO_PRIORITY);
  assert.equal(decoded.trackAlias, 1n);
  assert.equal(decoded.groupId, 50n);
  assert.equal(decoded.subgroupId, 7n);
  assert.isUndefined(decoded.publisherPriority);
  assert.equal(consumed, encoded.length);
});

test("ObjectDatagram: PAYLOAD_OBJ タイプ (0x00) をエンコード", () => {
  const datagram: ObjectDatagram = {
    type: DatagramType.PAYLOAD_OBJ,
    trackAlias: 5n,
    groupId: 10n,
    objectId: 3n,
    publisherPriority: 128,
    payload: new Uint8Array([0xaa, 0xbb, 0xcc]),
  };

  const encoded = encodeObjectDatagram(datagram);

  assert.equal(encoded[0], 0x00);
  assert.equal(encoded[1], 5);
  assert.equal(encoded[2], 10);
  assert.equal(encoded[3], 3);
  assert.equal(encoded[4], 128);
  assert.deepEqual(encoded.slice(5), new Uint8Array([0xaa, 0xbb, 0xcc]));
});

test("ObjectDatagram: PAYLOAD_NO_OBJ タイプ (0x04) をエンコード", () => {
  const datagram: ObjectDatagram = {
    type: DatagramType.PAYLOAD_NO_OBJ,
    trackAlias: 1n,
    groupId: 2n,
    objectId: 0n,
    publisherPriority: 100,
    payload: new Uint8Array([0x11, 0x22]),
  };

  const encoded = encodeObjectDatagram(datagram);

  assert.equal(encoded[0], 0x04);
  assert.equal(encoded[1], 1);
  assert.equal(encoded[2], 2);
  assert.equal(encoded[3], 100);
  assert.deepEqual(encoded.slice(4), new Uint8Array([0x11, 0x22]));
});

test("ObjectDatagram: STATUS_OBJ タイプ (0x20) をエンコード", () => {
  const datagram: ObjectDatagram = {
    type: DatagramType.STATUS_OBJ,
    trackAlias: 7n,
    groupId: 8n,
    objectId: 9n,
    publisherPriority: 50,
    status: ObjectStatus.END_OF_GROUP,
  };

  const encoded = encodeObjectDatagram(datagram);

  assert.equal(encoded[0], 0x20);
  assert.equal(encoded[1], 7);
  assert.equal(encoded[2], 8);
  assert.equal(encoded[3], 9);
  assert.equal(encoded[4], 50);
  assert.equal(encoded[5], ObjectStatus.END_OF_GROUP);
});

test("ObjectDatagram: PAYLOAD_OBJ_EXT タイプ (0x01) - Properties 付きをエンコード", () => {
  const properties = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
  const datagram: ObjectDatagram = {
    type: DatagramType.PAYLOAD_OBJ_EXT,
    trackAlias: 2n,
    groupId: 3n,
    objectId: 4n,
    publisherPriority: 200,
    properties,
    payload: new Uint8Array([0x01]),
  };

  const encoded = encodeObjectDatagram(datagram);

  assert.equal(encoded[0], 0x01);
  assert.equal(encoded[5], 4);
  assert.deepEqual(encoded.slice(6, 10), properties);
  assert.deepEqual(encoded.slice(10), new Uint8Array([0x01]));
});

test("ObjectDatagram: PAYLOAD_OBJ タイプをデコード", () => {
  const data = new Uint8Array([0x00, 0x05, 0x0a, 0x03, 0x80, 0xaa, 0xbb, 0xcc]);
  const [datagram, consumed] = decodeObjectDatagram(data);

  assert.equal(datagram.type, DatagramType.PAYLOAD_OBJ);
  assert.equal(datagram.trackAlias, 5n);
  assert.equal(datagram.groupId, 10n);
  assert.equal(datagram.objectId, 3n);
  assert.equal(datagram.publisherPriority, 128);
  assert.deepEqual(datagram.payload, new Uint8Array([0xaa, 0xbb, 0xcc]));
  assert.equal(consumed, 8);
});

test("ObjectDatagram: STATUS_OBJ タイプをデコード", () => {
  const data = new Uint8Array([0x20, 0x07, 0x08, 0x09, 0x32, ObjectStatus.END_OF_TRACK]);
  const [datagram, consumed] = decodeObjectDatagram(data);

  assert.equal(datagram.type, DatagramType.STATUS_OBJ);
  assert.equal(datagram.trackAlias, 7n);
  assert.equal(datagram.groupId, 8n);
  assert.equal(datagram.objectId, 9n);
  assert.equal(datagram.publisherPriority, 50);
  assert.equal(datagram.status, ObjectStatus.END_OF_TRACK);
  assert.equal(consumed, 6);
});

const objectDatagramTestCases: Array<{ name: string; datagram: ObjectDatagram }> = [
  {
    name: "PAYLOAD_OBJ",
    datagram: {
      type: DatagramType.PAYLOAD_OBJ,
      trackAlias: 100n,
      groupId: 200n,
      objectId: 50n,
      publisherPriority: 128,
      payload: new Uint8Array([0x01, 0x02, 0x03, 0x04]),
    },
  },
  {
    name: "PAYLOAD_NO_OBJ",
    datagram: {
      type: DatagramType.PAYLOAD_NO_OBJ,
      trackAlias: 10n,
      groupId: 20n,
      objectId: 0n,
      publisherPriority: 255,
      payload: new Uint8Array([0xff]),
    },
  },
  {
    name: "STATUS_OBJ",
    datagram: {
      type: DatagramType.STATUS_OBJ,
      trackAlias: 5n,
      groupId: 10n,
      objectId: 15n,
      publisherPriority: 0,
      status: ObjectStatus.END_OF_TRACK,
    },
  },
  {
    name: "PAYLOAD_OBJ_END_GROUP",
    datagram: {
      type: DatagramType.PAYLOAD_OBJ_END_GROUP,
      trackAlias: 1n,
      groupId: 1n,
      objectId: 1n,
      publisherPriority: 100,
      payload: new Uint8Array([0xaa]),
    },
  },
  // draft-ietf-moq-transport-18 Section 11.3.1:
  // 0x2C = STATUS(0x20) + DEFAULT_PRIORITY(0x08) + ZERO_OBJECT_ID(0x04)
  // Object ID フィールドなし (Object ID = 0)、Priority フィールドなし
  {
    name: "STATUS_NO_OBJ_NO_PRI (0x2C)",
    datagram: {
      type: DatagramType.STATUS_NO_OBJ_NO_PRI,
      trackAlias: 3n,
      groupId: 7n,
      objectId: 0n,
      publisherPriority: 0,
      status: ObjectStatus.END_OF_TRACK,
    },
  },
  // 0x2D = STATUS(0x20) + DEFAULT_PRIORITY(0x08) + ZERO_OBJECT_ID(0x04) + PROPERTIES(0x01)
  // NORMAL status + Properties 付き
  {
    name: "STATUS_NO_OBJ_EXT_NO_PRI (0x2D)",
    datagram: {
      type: DatagramType.STATUS_NO_OBJ_EXT_NO_PRI,
      trackAlias: 4n,
      groupId: 8n,
      objectId: 0n,
      publisherPriority: 0,
      status: ObjectStatus.NORMAL,
      properties: new Uint8Array([0x01, 0x02]),
    },
  },
];

for (const tc of objectDatagramTestCases) {
  test(`ObjectDatagram roundtrip: ${tc.name}`, () => {
    const encoded = encodeObjectDatagram(tc.datagram);
    const [decoded] = decodeObjectDatagram(encoded);

    assert.equal(decoded.type, tc.datagram.type);
    assert.equal(decoded.trackAlias, tc.datagram.trackAlias);
    assert.equal(decoded.groupId, tc.datagram.groupId);
    assert.equal(decoded.publisherPriority, tc.datagram.publisherPriority);

    if (tc.datagram.payload) {
      assert.deepEqual(decoded.payload, tc.datagram.payload);
    }
    if (tc.datagram.status !== undefined) {
      assert.equal(decoded.status, tc.datagram.status);
    }
  });
}

test("FetchHeader: 基本的な FetchHeader をエンコード", () => {
  const header: FetchHeader = {
    type: FetchHeaderType,
    requestId: 42n,
  };

  const encoded = encodeFetchHeader(header);

  assert.equal(encoded[0], 0x05);
  assert.equal(encoded[1], 42);
  assert.equal(encoded.length, 2);
});

test("FetchHeader: 大きな requestId をエンコード", () => {
  const header: FetchHeader = {
    type: FetchHeaderType,
    requestId: 10000n,
  };

  const encoded = encodeFetchHeader(header);

  assert.equal(encoded[0], 0x05);
  assert.isAbove(encoded.length, 2);
});

test("FetchHeader: 基本的な FetchHeader をデコード", () => {
  const data = new Uint8Array([0x05, 0x2a]);
  const [header, consumed] = decodeFetchHeader(data);

  assert.equal(header.type, FetchHeaderType);
  assert.equal(header.requestId, 42n);
  assert.equal(consumed, 2);
});

test("FetchHeader: 無効な type でエラー", () => {
  const data = new Uint8Array([0x10, 0x01]);

  assert.throws(() => decodeFetchHeader(data), "invalid fetch header type");
});

const requestIds = [0n, 1n, 100n, 1000n, 10000n];

for (const requestId of requestIds) {
  test(`FetchHeader roundtrip: requestId=${requestId}`, () => {
    const header: FetchHeader = {
      type: FetchHeaderType,
      requestId,
    };

    const encoded = encodeFetchHeader(header);
    const [decoded, consumed] = decodeFetchHeader(encoded);

    assert.equal(decoded.type, FetchHeaderType);
    assert.equal(decoded.requestId, requestId);
    assert.equal(consumed, encoded.length);
  });
}

test("FetchObjectFields: createFirstFetchObjectFlags で Properties なしフラグを作成", () => {
  const flags = createFirstFetchObjectFlags(false);

  assert.isOk(flags & FetchSerializationFlags.GROUP_ID_PRESENT);
  assert.equal(
    flags & FetchSerializationFlags.SUBGROUP_MASK,
    FetchSerializationFlags.SUBGROUP_PRESENT,
  );
  assert.isOk(flags & FetchSerializationFlags.OBJECT_ID_PRESENT);
  assert.isOk(flags & FetchSerializationFlags.PRIORITY_PRESENT);
  assert.isNotOk(flags & FetchSerializationFlags.PROPERTIES_PRESENT);
});

test("FetchObjectFields: createFirstFetchObjectFlags で Properties ありフラグを作成", () => {
  const flags = createFirstFetchObjectFlags(true);

  assert.isOk(flags & FetchSerializationFlags.PROPERTIES_PRESENT);
});

test("FetchObjectFields: 最初のオブジェクトをエンコード", () => {
  const flags = createFirstFetchObjectFlags(false);
  const fields: FetchObjectFields = {
    serializationFlags: flags,
    groupId: 5n,
    subgroupId: 2n,
    objectId: 10n,
    publisherPriority: 64,
    payloadLength: 50n,
  };

  const encoded = encodeFetchObjectFields(fields);

  assert.equal(encoded[0], flags);
  assert.equal(encoded[1], 5);
  assert.equal(encoded[2], 2);
  assert.equal(encoded[3], 10);
  assert.equal(encoded[4], 64);
  assert.equal(encoded[5], 50);
});

// draft-ietf-moq-transport-18 Section 11.2.1.1:
// "The Object Status is a field that is only present in objects that are
// delivered via a SUBSCRIPTION, and is absent in Objects delivered via a FETCH."
test("FetchObjectFields: payload length = 0 でも Object Status を含めない", () => {
  const flags = createFirstFetchObjectFlags(false);
  const fields: FetchObjectFields = {
    serializationFlags: flags,
    groupId: 1n,
    subgroupId: 0n,
    objectId: 0n,
    publisherPriority: 100,
    payloadLength: 0n,
  };

  const encoded = encodeFetchObjectFields(fields);
  // Payload Length (0) の後に Object Status は含まれない
  const lastByte = encoded[encoded.length - 1];
  assert.equal(lastByte, 0);

  const [decoded] = decodeFetchObjectFields(encoded, null, 0, true);
  assert.equal(decoded.payloadLength, 0n);
  // DecodedFetchObject には status フィールドが存在しないことを確認
  assert.equal("status" in decoded, false);
});

test("FetchObjectFields: 最初のオブジェクトをデコード", () => {
  const flags = createFirstFetchObjectFlags(false);
  const data = new Uint8Array([flags, 5, 2, 10, 64, 50]);

  const [decoded, consumed, context] = decodeFetchObjectFields(data, null, 0, true);

  assert.equal(decoded.groupId, 5n);
  assert.equal(decoded.subgroupId, 2n);
  assert.equal(decoded.objectId, 10n);
  assert.equal(decoded.publisherPriority, 64);
  assert.equal(decoded.payloadLength, 50n);
  assert.equal(consumed, 6);
  assert.equal(context.groupId, 5n);
});

test("FetchObjectFields: 2番目のオブジェクトをデコード (差分エンコーディング)", () => {
  const context: FetchObjectContext = {
    groupId: 5n,
    subgroupId: 2n,
    objectId: 10n,
    publisherPriority: 128,
  };

  const flags = FetchSerializationFlags.SUBGROUP_SAME;
  const data = new Uint8Array([flags, 50]);

  const [decoded, consumed, newContext] = decodeFetchObjectFields(data, context, 0, false);

  assert.equal(decoded.groupId, 5n);
  assert.equal(decoded.subgroupId, 2n);
  assert.equal(decoded.objectId, 11n);
  assert.equal(decoded.publisherPriority, 128);
  assert.equal(decoded.payloadLength, 50n);
  assert.equal(consumed, 2);
  assert.equal(newContext.objectId, 11n);
});

/**
 * draft-ietf-moq-transport-18 Section 11.4.4:
 * 0x40 は Datagram フラグとして定義された。
 * 不正な Serialization Flags 値はプロトコル違反。
 */
test("FetchObjectFields: 最初のオブジェクトで prior 参照使用はエラー", () => {
  // 0x40 (Datagram) は有効だが、GROUP_ID_PRESENT が未設定なのでエラー
  const flags = FetchSerializationFlags.DATAGRAM;
  const data = new Uint8Array([flags, 0, 0, 0, 0, 10]);

  assert.throws(
    () => decodeFetchObjectFields(data, null, 0, true),
    "first object must have GROUP_ID_PRESENT flag set",
  );
});

test("FetchObjectFields: 最初のオブジェクトで GROUP_ID_PRESENT なしはエラー", () => {
  const flags =
    FetchSerializationFlags.SUBGROUP_PRESENT |
    FetchSerializationFlags.OBJECT_ID_PRESENT |
    FetchSerializationFlags.PRIORITY_PRESENT;
  const data = new Uint8Array([flags, 0, 0, 0, 10]);

  assert.throws(
    () => decodeFetchObjectFields(data, null, 0, true),
    "first object must have GROUP_ID_PRESENT flag set",
  );
});

test("FetchObjectFields: 最初のオブジェクトの roundtrip", () => {
  const flags = createFirstFetchObjectFlags(false);
  const original: FetchObjectFields = {
    serializationFlags: flags,
    groupId: 100n,
    subgroupId: 5n,
    objectId: 50n,
    publisherPriority: 200,
    payloadLength: 1000n,
  };

  const encoded = encodeFetchObjectFields(original);
  const [decoded, , context] = decodeFetchObjectFields(encoded, null, 0, true);

  assert.equal(decoded.groupId, 100n);
  assert.equal(decoded.subgroupId, 5n);
  assert.equal(decoded.objectId, 50n);
  assert.equal(decoded.publisherPriority, 200);
  assert.equal(decoded.payloadLength, 1000n);
  assert.equal(context.groupId, 100n);
});

test("FetchObjectFields: 複数オブジェクトの連続デコード", () => {
  const firstFlags = createFirstFetchObjectFlags(false);
  const first: FetchObjectFields = {
    serializationFlags: firstFlags,
    groupId: 10n,
    subgroupId: 1n,
    objectId: 0n,
    publisherPriority: 128,
    payloadLength: 100n,
  };

  const firstEncoded = encodeFetchObjectFields(first);
  const [firstDecoded, , firstContext] = decodeFetchObjectFields(firstEncoded, null, 0, true);

  assert.equal(firstDecoded.groupId, 10n);
  assert.equal(firstDecoded.objectId, 0n);

  const secondFlags = FetchSerializationFlags.SUBGROUP_SAME;
  const second: FetchObjectFields = {
    serializationFlags: secondFlags,
    payloadLength: 50n,
  };

  const secondEncoded = encodeFetchObjectFields(second);
  const [secondDecoded, , secondContext] = decodeFetchObjectFields(
    secondEncoded,
    firstContext,
    0,
    false,
  );

  assert.equal(secondDecoded.groupId, 10n);
  assert.equal(secondDecoded.subgroupId, 1n);
  assert.equal(secondDecoded.objectId, 1n);
  assert.equal(secondDecoded.publisherPriority, 128);
  assert.equal(secondDecoded.payloadLength, 50n);
  assert.equal(secondContext.objectId, 1n);
});

test("FetchObjectFields: 同じ groupId で SUBGROUP_PLUS_ONE を生成", () => {
  const prior: FetchObjectContext = {
    groupId: 5n,
    subgroupId: 2n,
    objectId: 10n,
    publisherPriority: 128,
  };
  const current = {
    groupId: 5n,
    subgroupId: 3n,
    objectId: 11n,
    publisherPriority: 128,
  };

  const flags = createFetchObjectFlags(current, prior);

  assert.isNotOk(flags & FetchSerializationFlags.GROUP_ID_PRESENT);
  assert.equal(
    flags & FetchSerializationFlags.SUBGROUP_MASK,
    FetchSerializationFlags.SUBGROUP_PLUS_ONE,
  );
  assert.isNotOk(flags & FetchSerializationFlags.OBJECT_ID_PRESENT);
  assert.isNotOk(flags & FetchSerializationFlags.PRIORITY_PRESENT);
});

test("FetchObjectFields: groupId が異なる場合 GROUP_ID_PRESENT を設定", () => {
  const prior: FetchObjectContext = {
    groupId: 5n,
    subgroupId: 2n,
    objectId: 10n,
    publisherPriority: 128,
  };
  const current = {
    groupId: 6n,
    subgroupId: 0n,
    objectId: 0n,
    publisherPriority: 128,
  };

  const flags = createFetchObjectFlags(current, prior);

  assert.isOk(flags & FetchSerializationFlags.GROUP_ID_PRESENT);
  assert.isOk(flags & FetchSerializationFlags.OBJECT_ID_PRESENT);
});

/**
 * 同一 Subgroup の Priority 一貫性検証テスト
 * draft-ietf-moq-transport-18:
 * 同一 Subgroup 内のオブジェクトは同じ Priority を持つ必要がある。
 * draft-ietf-moq-transport-18 Section 11.4.4
 */
test("FetchObjectFields: 同一 Subgroup で異なる Priority はエラー", () => {
  // 最初のオブジェクト
  const first: FetchObjectFields = {
    serializationFlags: createFirstFetchObjectFlags(),
    groupId: 10n,
    subgroupId: 1n,
    objectId: 0n,
    publisherPriority: 100,
    payloadLength: 50n,
  };
  const firstEncoded = encodeFetchObjectFields(first);
  const [, , firstContext] = decodeFetchObjectFields(firstEncoded, null, 0, true);

  // 同じ Subgroup で異なる Priority を持つオブジェクト
  // SUBGROUP_SAME + OBJECT_ID_PRESENT + PRIORITY_PRESENT を設定
  const secondFlags =
    FetchSerializationFlags.SUBGROUP_SAME |
    FetchSerializationFlags.OBJECT_ID_PRESENT |
    FetchSerializationFlags.PRIORITY_PRESENT;
  const objectIdBytes = encodeVarint(1n);
  const payloadLengthBytes = encodeVarint(50n);

  const secondEncoded = new Uint8Array(1 + objectIdBytes.length + 1 + payloadLengthBytes.length);
  secondEncoded[0] = secondFlags;
  let offset = 1;
  secondEncoded.set(objectIdBytes, offset);
  offset += objectIdBytes.length;
  secondEncoded[offset] = 200; // 異なる Priority
  offset += 1;
  secondEncoded.set(payloadLengthBytes, offset);

  assert.throws(
    () => decodeFetchObjectFields(secondEncoded, firstContext, 0, false),
    /malformed track: different priorities in same subgroup/,
  );
});

test("FetchObjectFields: 異なる Subgroup で異なる Priority は許可", () => {
  // 最初のオブジェクト
  const first: FetchObjectFields = {
    serializationFlags: createFirstFetchObjectFlags(),
    groupId: 10n,
    subgroupId: 1n,
    objectId: 0n,
    publisherPriority: 100,
    payloadLength: 50n,
  };
  const firstEncoded = encodeFetchObjectFields(first);
  const [, , firstContext] = decodeFetchObjectFields(firstEncoded, null, 0, true);

  // 異なる Subgroup で異なる Priority
  // GROUP_ID省略 + SUBGROUP_PLUS_ONE + OBJECT_ID_PRESENT + PRIORITY_PRESENT
  const secondFlags =
    FetchSerializationFlags.SUBGROUP_PLUS_ONE |
    FetchSerializationFlags.OBJECT_ID_PRESENT |
    FetchSerializationFlags.PRIORITY_PRESENT;
  const objectIdBytes = encodeVarint(0n);
  const payloadLengthBytes = encodeVarint(50n);

  const secondEncoded = new Uint8Array(1 + objectIdBytes.length + 1 + payloadLengthBytes.length);
  secondEncoded[0] = secondFlags;
  let offset = 1;
  secondEncoded.set(objectIdBytes, offset);
  offset += objectIdBytes.length;
  secondEncoded[offset] = 200; // 異なる Priority
  offset += 1;
  secondEncoded.set(payloadLengthBytes, offset);

  const [decoded] = decodeFetchObjectFields(secondEncoded, firstContext, 0, false);

  // subgroupId = context.subgroupId + 1 = 1 + 1 = 2
  assert.equal(decoded.subgroupId, 2n);
  assert.equal(decoded.publisherPriority, 200);
});

/**
 * draft-ietf-moq-transport-18 §11.4.4.1 Table 9:
 * "If the Group Order is Ascending (default), the Group ID is the prior
 *  Object's Group ID plus the Group ID Delta + 1."
 *
 * 非先頭オブジェクトで GROUP_ID_PRESENT がセットされている場合、
 * delta から正しい Group ID (prior + delta + 1) を計算することを検証する。
 */
test("FetchObjectFields: 非先頭オブジェクトの Group ID Delta を正しくデコードする", () => {
  const prior: FetchObjectContext = {
    groupId: 10n,
    subgroupId: 1n,
    objectId: 5n,
    publisherPriority: 128,
  };

  // GROUP_ID_PRESENT | SUBGROUP_ZERO | OBJECT_ID_PRESENT | PRIORITY_PRESENT
  const flags =
    FetchSerializationFlags.GROUP_ID_PRESENT |
    FetchSerializationFlags.SUBGROUP_ZERO |
    FetchSerializationFlags.OBJECT_ID_PRESENT |
    FetchSerializationFlags.PRIORITY_PRESENT;

  // delta_group=3, objectId=0(絶対値), priority=200, payloadLength=50
  const groupDeltaBytes = encodeVarint(3n);
  const objectIdBytes = encodeVarint(0n);
  const payloadLengthBytes = encodeVarint(50n);

  const data = new Uint8Array(
    1 + groupDeltaBytes.length + objectIdBytes.length + 1 + payloadLengthBytes.length,
  );
  data[0] = flags;
  let offset = 1;
  data.set(groupDeltaBytes, offset);
  offset += groupDeltaBytes.length;
  data.set(objectIdBytes, offset);
  offset += objectIdBytes.length;
  data[offset] = 200;
  offset += 1;
  data.set(payloadLengthBytes, offset);

  const [decoded, , newContext] = decodeFetchObjectFields(data, prior, 0, false);

  // groupId = prior.groupId + delta + 1 = 10 + 3 + 1 = 14
  assert.equal(decoded.groupId, 14n);
  // subgroupId = 0 (SUBGROUP_ZERO)
  assert.equal(decoded.subgroupId, 0n);
  // objectId = 0 (Group 変化時は絶対値)
  assert.equal(decoded.objectId, 0n);
  assert.equal(decoded.publisherPriority, 200);
  assert.equal(decoded.payloadLength, 50n);
  assert.equal(newContext.groupId, 14n);
});

/**
 * draft-ietf-moq-transport-18 §11.4.4.1 Table 9:
 * "When the Group ID Delta field is not present, the Object ID is the
 *  prior Object's ID plus the Object ID Delta if present."
 *
 * 非先頭オブジェクトで GROUP_ID_PRESENT なし、OBJECT_ID_PRESENT ありの場合、
 * delta から正しい Object ID (prior + delta) を計算することを検証する。
 */
test("FetchObjectFields: 非先頭オブジェクトの Object ID Delta (Group 不変) を正しくデコードする", () => {
  const prior: FetchObjectContext = {
    groupId: 10n,
    subgroupId: 1n,
    objectId: 5n,
    publisherPriority: 128,
  };

  // SUBGROUP_SAME | OBJECT_ID_PRESENT
  const flags = FetchSerializationFlags.SUBGROUP_SAME | FetchSerializationFlags.OBJECT_ID_PRESENT;

  // delta_object=3 (Group 不変時は prior + delta)
  const objectDeltaBytes = encodeVarint(3n);
  const payloadLengthBytes = encodeVarint(50n);

  const data = new Uint8Array(1 + objectDeltaBytes.length + payloadLengthBytes.length);
  data[0] = flags;
  data.set(objectDeltaBytes, 1);
  data.set(payloadLengthBytes, 1 + objectDeltaBytes.length);

  const [decoded, , newContext] = decodeFetchObjectFields(data, prior, 0, false);

  // groupId = 10 (変化なし)
  assert.equal(decoded.groupId, 10n);
  // subgroupId = 1 (SUBGROUP_SAME)
  assert.equal(decoded.subgroupId, 1n);
  // objectId = prior.objectId + delta = 5 + 3 = 8
  assert.equal(decoded.objectId, 8n);
  assert.equal(decoded.publisherPriority, 128);
  assert.equal(decoded.payloadLength, 50n);
  assert.equal(newContext.objectId, 8n);
});

/**
 * draft-ietf-moq-transport-18 §11.4.4.1:
 * encode → decode で複数オブジェクトの delta encoding が正しく roundtrip することを検証する。
 * オブジェクト 1: group=10, object=0  (先頭)
 * オブジェクト 2: group=10, object=3  (Group 不変, OBJECT_ID_PRESENT, delta エンコード)
 * オブジェクト 3: group=14, object=0  (Group 変更, GROUP_ID_PRESENT, delta エンコード)
 */
test("FetchObjectFields: encode→decode roundtrip で delta encoding が正しく復元される", () => {
  // オブジェクト 1 (先頭): group=10, object=0
  const firstFlags = createFirstFetchObjectFlags(false);
  const first: FetchObjectFields = {
    serializationFlags: firstFlags,
    groupId: 10n,
    subgroupId: 1n,
    objectId: 0n,
    publisherPriority: 100,
    payloadLength: 50n,
  };
  const firstEncoded = encodeFetchObjectFields(first);
  const [firstDecoded, , firstContext] = decodeFetchObjectFields(firstEncoded, null, 0, true);
  assert.equal(firstDecoded.groupId, 10n);
  assert.equal(firstDecoded.objectId, 0n);

  // オブジェクト 2: Group 不変, object=3 (delta=3), SUBGROUP_SAME
  const second: FetchObjectFields = {
    serializationFlags:
      FetchSerializationFlags.SUBGROUP_SAME | FetchSerializationFlags.OBJECT_ID_PRESENT,
    objectId: 3n,
    payloadLength: 80n,
  };
  const secondEncoded = encodeFetchObjectFields(second, false, firstContext);
  const [secondDecoded, , secondContext] = decodeFetchObjectFields(
    secondEncoded,
    firstContext,
    0,
    false,
  );
  assert.equal(secondDecoded.groupId, 10n);
  assert.equal(secondDecoded.objectId, 3n);
  assert.equal(secondDecoded.payloadLength, 80n);

  // オブジェクト 3: Group 変更 (10 → 14, delta=14-10-1=3), object=0
  const third: FetchObjectFields = {
    serializationFlags:
      FetchSerializationFlags.GROUP_ID_PRESENT |
      FetchSerializationFlags.SUBGROUP_ZERO |
      FetchSerializationFlags.OBJECT_ID_PRESENT |
      FetchSerializationFlags.PRIORITY_PRESENT,
    groupId: 14n,
    subgroupId: 0n,
    objectId: 0n,
    publisherPriority: 200,
    payloadLength: 30n,
  };
  const thirdEncoded = encodeFetchObjectFields(third, false, secondContext);
  const [thirdDecoded] = decodeFetchObjectFields(thirdEncoded, secondContext, 0, false);
  assert.equal(thirdDecoded.groupId, 14n);
  assert.equal(thirdDecoded.subgroupId, 0n);
  assert.equal(thirdDecoded.objectId, 0n);
  assert.equal(thirdDecoded.publisherPriority, 200);
  assert.equal(thirdDecoded.payloadLength, 30n);
});

// ============================================================================
// Fetch Object Fields - Descending Group Order のテスト
// ============================================================================

/**
 * draft-ietf-moq-transport-18 §11.4.4.1 Table 9:
 * "If the Group Order is Descending, the Group ID is the prior Object's
 *  Group ID minus the (Group ID Delta + 1)."
 *
 * Descending 時に正しい Group ID を計算することを検証する。
 */
test("FetchObjectFields: Descending Group Order で Group ID を正しくデコードする", () => {
  const prior: FetchObjectContext = {
    groupId: 100n,
    subgroupId: 1n,
    objectId: 5n,
    publisherPriority: 128,
  };

  // GROUP_ID_PRESENT | SUBGROUP_ZERO | OBJECT_ID_PRESENT | PRIORITY_PRESENT
  const flags =
    FetchSerializationFlags.GROUP_ID_PRESENT |
    FetchSerializationFlags.SUBGROUP_ZERO |
    FetchSerializationFlags.OBJECT_ID_PRESENT |
    FetchSerializationFlags.PRIORITY_PRESENT;

  // delta_group=3, objectId=0(絶対値), priority=200, payloadLength=50
  const groupDeltaBytes = encodeVarint(3n);
  const objectIdBytes = encodeVarint(0n);
  const payloadLengthBytes = encodeVarint(50n);

  const data = new Uint8Array(
    1 + groupDeltaBytes.length + objectIdBytes.length + 1 + payloadLengthBytes.length,
  );
  data[0] = flags;
  let offset = 1;
  data.set(groupDeltaBytes, offset);
  offset += groupDeltaBytes.length;
  data.set(objectIdBytes, offset);
  offset += objectIdBytes.length;
  data[offset] = 200;
  offset += 1;
  data.set(payloadLengthBytes, offset);

  const [decoded, , newContext] = decodeFetchObjectFields(
    data,
    prior,
    0,
    false,
    GroupOrder.DESCENDING,
  );

  // groupId = prior.groupId - delta - 1 = 100 - 3 - 1 = 96
  assert.equal(decoded.groupId, 96n);
  assert.equal(decoded.subgroupId, 0n);
  assert.equal(decoded.objectId, 0n);
  assert.equal(decoded.publisherPriority, 200); // サブグループが異なるので異なる Priority で問題なし
  assert.equal(decoded.payloadLength, 50n);
  assert.equal(newContext.groupId, 96n);
});

/**
 * draft-ietf-moq-transport-18 §11.4.4.1 Table 9:
 * "If the Group Order is Descending, the Group ID is the prior Object's
 *  Group ID minus the (Group ID Delta + 1)."
 *
 * "If the computed Group ID would be less than 0 or greater than 2^64-1,
 *  the Subscriber MUST close the Session with error 'PROTOCOL_VIOLATION'."
 *
 * Descending 時に Group ID が 0 未満になる場合、ProtocolViolationError が throw されることを検証する。
 */
test("FetchObjectFields: Descending で Group ID が 0 未満になる場合は ProtocolViolationError", () => {
  const prior: FetchObjectContext = {
    groupId: 2n,
    subgroupId: 1n,
    objectId: 5n,
    publisherPriority: 128,
  };

  // GROUP_ID_PRESENT | SUBGROUP_ZERO | OBJECT_ID_PRESENT | PRIORITY_PRESENT
  const flags =
    FetchSerializationFlags.GROUP_ID_PRESENT |
    FetchSerializationFlags.SUBGROUP_ZERO |
    FetchSerializationFlags.OBJECT_ID_PRESENT |
    FetchSerializationFlags.PRIORITY_PRESENT;

  // delta_group=5 → groupId = prior.groupId - delta - 1 = 2 - 5 - 1 = -4 (< 0)
  const groupDeltaBytes = encodeVarint(5n);
  const objectIdBytes = encodeVarint(0n);
  const payloadLengthBytes = encodeVarint(50n);

  const data = new Uint8Array(
    1 + groupDeltaBytes.length + objectIdBytes.length + 1 + payloadLengthBytes.length,
  );
  data[0] = flags;
  let offset = 1;
  data.set(groupDeltaBytes, offset);
  offset += groupDeltaBytes.length;
  data.set(objectIdBytes, offset);
  offset += objectIdBytes.length;
  data[offset] = 200;
  offset += 1;
  data.set(payloadLengthBytes, offset);

  assert.throws(
    () => decodeFetchObjectFields(data, prior, 0, false, GroupOrder.DESCENDING),
    /computed group id out of range/,
  );
});

/**
 * Descending Group Order で encode→decode roundtrip が正しく動作することを検証する。
 */
test("FetchObjectFields: Descending Group Order で encode→decode roundtrip が成功する", () => {
  // オブジェクト 1 (先頭): group=100, object=0
  const firstFlags = createFirstFetchObjectFlags(false);
  const first: FetchObjectFields = {
    serializationFlags: firstFlags,
    groupId: 100n,
    subgroupId: 1n,
    objectId: 0n,
    publisherPriority: 100,
    payloadLength: 50n,
  };
  const firstEncoded = encodeFetchObjectFields(first, false, null, GroupOrder.DESCENDING);
  const [firstDecoded, , firstContext] = decodeFetchObjectFields(
    firstEncoded,
    null,
    0,
    true,
    GroupOrder.DESCENDING,
  );
  assert.equal(firstDecoded.groupId, 100n);
  assert.equal(firstDecoded.objectId, 0n);

  // オブジェクト 2: Group 減少 (100 → 95, delta=100-95-1=4)
  // 同一 Subgroup の Priority 一貫性を保つため、同じ Priority を使用する
  const second: FetchObjectFields = {
    serializationFlags:
      FetchSerializationFlags.GROUP_ID_PRESENT |
      FetchSerializationFlags.SUBGROUP_SAME |
      FetchSerializationFlags.OBJECT_ID_PRESENT |
      FetchSerializationFlags.PRIORITY_PRESENT,
    groupId: 95n,
    objectId: 2n,
    publisherPriority: 100, // 先頭と同じ Priority
    payloadLength: 80n,
  };
  const secondEncoded = encodeFetchObjectFields(second, false, firstContext, GroupOrder.DESCENDING);
  const [secondDecoded, , secondContext] = decodeFetchObjectFields(
    secondEncoded,
    firstContext,
    0,
    false,
    GroupOrder.DESCENDING,
  );
  assert.equal(secondDecoded.groupId, 95n);
  assert.equal(secondDecoded.objectId, 2n);
  assert.equal(secondDecoded.payloadLength, 80n);

  // オブジェクト 3: Group さらに減少 (95 → 80, delta=95-80-1=14)
  const third: FetchObjectFields = {
    serializationFlags:
      FetchSerializationFlags.GROUP_ID_PRESENT |
      FetchSerializationFlags.SUBGROUP_SAME |
      FetchSerializationFlags.OBJECT_ID_PRESENT |
      FetchSerializationFlags.PRIORITY_PRESENT,
    groupId: 80n,
    objectId: 5n,
    publisherPriority: 100, // 先頭と同じ Priority
    payloadLength: 30n,
  };
  const thirdEncoded = encodeFetchObjectFields(third, false, secondContext, GroupOrder.DESCENDING);
  const [thirdDecoded] = decodeFetchObjectFields(
    thirdEncoded,
    secondContext,
    0,
    false,
    GroupOrder.DESCENDING,
  );
  assert.equal(thirdDecoded.groupId, 80n);
  assert.equal(thirdDecoded.objectId, 5n);
});

/**
 * Ascending Group Order で Group ID が 2^64-1 を超過する場合の検証。
 */
test("FetchObjectFields: Ascending で Group ID が 2^64-1 を超過する場合は ProtocolViolationError", () => {
  const prior: FetchObjectContext = {
    groupId: (1n << 64n) - 1n,
    subgroupId: 1n,
    objectId: 5n,
    publisherPriority: 128,
  };

  const flags =
    FetchSerializationFlags.GROUP_ID_PRESENT |
    FetchSerializationFlags.SUBGROUP_ZERO |
    FetchSerializationFlags.OBJECT_ID_PRESENT |
    FetchSerializationFlags.PRIORITY_PRESENT;

  // delta_group=0 → groupId = prior.groupId + delta + 1 = (2^64-1) + 0 + 1 = 2^64 (overflow)
  const groupDeltaBytes = encodeVarint(0n);
  const objectIdBytes = encodeVarint(0n);
  const payloadLengthBytes = encodeVarint(50n);

  const data = new Uint8Array(
    1 + groupDeltaBytes.length + objectIdBytes.length + 1 + payloadLengthBytes.length,
  );
  data[0] = flags;
  let offset = 1;
  data.set(groupDeltaBytes, offset);
  offset += groupDeltaBytes.length;
  data.set(objectIdBytes, offset);
  offset += objectIdBytes.length;
  data[offset] = 200;
  offset += 1;
  data.set(payloadLengthBytes, offset);

  assert.throws(
    () => decodeFetchObjectFields(data, prior, 0, false, GroupOrder.ASCENDING),
    /computed group id out of range/,
  );
});

/**
 * Descending Group Order で Group ID が 2^64-1 を超過する場合の検証。
 * prior = 0, delta = 0 → groupId = 0 - 0 - 1 = -1 (< 0)、0 未満のため out of range。
 */
test("FetchObjectFields: Descending で prior=0,delta=0 の場合は Group ID が 0 未満で ProtocolViolationError", () => {
  const prior: FetchObjectContext = {
    groupId: 0n,
    subgroupId: 1n,
    objectId: 5n,
    publisherPriority: 128,
  };

  const flags =
    FetchSerializationFlags.GROUP_ID_PRESENT |
    FetchSerializationFlags.SUBGROUP_ZERO |
    FetchSerializationFlags.OBJECT_ID_PRESENT |
    FetchSerializationFlags.PRIORITY_PRESENT;

  const groupDeltaBytes = encodeVarint(0n);
  const objectIdBytes = encodeVarint(0n);
  const payloadLengthBytes = encodeVarint(50n);

  const data = new Uint8Array(
    1 + groupDeltaBytes.length + objectIdBytes.length + 1 + payloadLengthBytes.length,
  );
  data[0] = flags;
  let offset = 1;
  data.set(groupDeltaBytes, offset);
  offset += groupDeltaBytes.length;
  data.set(objectIdBytes, offset);
  offset += objectIdBytes.length;
  data[offset] = 200;
  offset += 1;
  data.set(payloadLengthBytes, offset);

  assert.throws(
    () => decodeFetchObjectFields(data, prior, 0, false, GroupOrder.DESCENDING),
    /computed group id out of range/,
  );
});

// ============================================================================
// Fetch Object Fields - DATAGRAM フラグ (0x40) のテスト
// ============================================================================

/**
 * draft-ietf-moq-transport-18 §11.4.4.1:
 * "the object has no Subgroup ID. The publisher MUST SET bit 0x40 to '1'."
 * "the subscriber MUST ignore the bits."
 *
 * DATAGRAM (0x40) 単独の先頭オブジェクトを正しくデコードすることを検証する。
 */
test("FetchObjectFields: DATAGRAM (0x40) の先頭オブジェクトを正しくデコードする", () => {
  const flags =
    FetchSerializationFlags.DATAGRAM |
    FetchSerializationFlags.GROUP_ID_PRESENT |
    FetchSerializationFlags.OBJECT_ID_PRESENT |
    FetchSerializationFlags.PRIORITY_PRESENT;

  const data = new Uint8Array([flags, 5, 10, 64, 50]);

  const [decoded, , context] = decodeFetchObjectFields(data, null, 0, true);

  assert.equal(decoded.groupId, 5n);
  assert.equal(decoded.subgroupId, 0n);
  assert.equal(decoded.objectId, 10n);
  assert.equal(decoded.publisherPriority, 64);
  assert.equal(decoded.payloadLength, 50n);
  assert.equal(context.subgroupId, 0n);
});

/**
 * DATAGRAM + SUBGROUP_PRESENT (0x43): wire 上の Subgroup ID vi64 を読み飛ばし、
 * subgroupId = 0n を返すことを検証する。
 *
 * ワイヤーフォーマット: flags, group_id, subgroup_id, object_id, priority, payload_length
 * DATAGRAM+SUBGROUP_PRESENT なので group_id の後の subgroup_id_vi64 は読み飛ばされる。
 */
test("FetchObjectFields: DATAGRAM+SUBGROUP_PRESENT (0x43) で Subgroup ID vi64 を読み飛ばす", () => {
  const flags =
    FetchSerializationFlags.DATAGRAM |
    FetchSerializationFlags.SUBGROUP_PRESENT |
    FetchSerializationFlags.GROUP_ID_PRESENT |
    FetchSerializationFlags.OBJECT_ID_PRESENT |
    FetchSerializationFlags.PRIORITY_PRESENT;

  // wire: [flags][groupId=5][subgroupId_vi64=99][objectId=10][priority=64][payloadLength=50]
  const subgroupIdBytes = encodeVarint(99n);
  const data = new Uint8Array(1 + 1 + subgroupIdBytes.length + 3);
  data[0] = flags;
  data[1] = 5; // groupId
  data.set(subgroupIdBytes, 2);
  data[2 + subgroupIdBytes.length] = 10; // objectId
  data[2 + subgroupIdBytes.length + 1] = 64; // priority
  data[2 + subgroupIdBytes.length + 2] = 50; // payloadLength

  const [decoded] = decodeFetchObjectFields(data, null, 0, true);

  assert.equal(decoded.groupId, 5n);
  assert.equal(decoded.subgroupId, 0n); // 読み飛ばしたので 0n
  assert.equal(decoded.objectId, 10n);
  assert.equal(decoded.publisherPriority, 64);
  assert.equal(decoded.payloadLength, 50n);
});

/**
 * DATAGRAM + SUBGROUP_SAME (0x41) の先頭オブジェクト:
 * 下位ビットが SUBGROUP_SAME (0x01) でも、DATAGRAM ビットにより無視されるため
 * "first object cannot use SUBGROUP_SAME" が throw されないことを検証する。
 */
test("FetchObjectFields: DATAGRAM+SUBGROUP_SAME (0x41) の先頭オブジェクトがエラーにならない", () => {
  const flags =
    FetchSerializationFlags.DATAGRAM |
    FetchSerializationFlags.SUBGROUP_SAME |
    FetchSerializationFlags.GROUP_ID_PRESENT |
    FetchSerializationFlags.OBJECT_ID_PRESENT |
    FetchSerializationFlags.PRIORITY_PRESENT;

  const data = new Uint8Array([flags, 1, 0, 128, 50]);

  const [decoded] = decodeFetchObjectFields(data, null, 0, true);

  assert.equal(decoded.subgroupId, 0n);
  assert.equal(decoded.groupId, 1n);
});

/**
 * DATAGRAM + SUBGROUP_PLUS_ONE (0x42) の先頭オブジェクト:
 * 下位ビットが SUBGROUP_PLUS_ONE でも DATAGRAM により無視されるためエラーにならない。
 */
test("FetchObjectFields: DATAGRAM+SUBGROUP_PLUS_ONE (0x42) の先頭オブジェクトがエラーにならない", () => {
  const flags =
    FetchSerializationFlags.DATAGRAM |
    FetchSerializationFlags.SUBGROUP_PLUS_ONE |
    FetchSerializationFlags.GROUP_ID_PRESENT |
    FetchSerializationFlags.OBJECT_ID_PRESENT |
    FetchSerializationFlags.PRIORITY_PRESENT;

  const data = new Uint8Array([flags, 1, 0, 128, 50]);

  const [decoded] = decodeFetchObjectFields(data, null, 0, true);

  assert.equal(decoded.subgroupId, 0n);
  assert.equal(decoded.groupId, 1n);
});

/**
 * 非 Datagram → Datagram → 非 Datagram の混在シーケンスで
 * Subgroup ID が正しく伝搬することを検証する。
 */
test("FetchObjectFields: 非Datagram→Datagram→非Datagram の混在で Subgroup ID が正しく伝搬する", () => {
  // オブジェクト 1: 非 Datagram (SUBGROUP_PRESENT)
  const firstFlags = createFirstFetchObjectFlags(false, false);
  const first: FetchObjectFields = {
    serializationFlags: firstFlags,
    groupId: 10n,
    subgroupId: 5n,
    objectId: 0n,
    publisherPriority: 100,
    payloadLength: 50n,
  };
  const firstEncoded = encodeFetchObjectFields(first);
  const [, , firstContext] = decodeFetchObjectFields(firstEncoded, null, 0, true);
  assert.equal(firstContext.subgroupId, 5n);

  // オブジェクト 2: Datagram (0x40) + GROUP_ID_PRESENT + ...
  const secondFlags =
    FetchSerializationFlags.DATAGRAM |
    FetchSerializationFlags.GROUP_ID_PRESENT |
    FetchSerializationFlags.OBJECT_ID_PRESENT |
    FetchSerializationFlags.PRIORITY_PRESENT;
  const groupDeltaBytes = encodeVarint(0n); // delta=0 → groupId=10+0+1=11
  const secondEncoded = new Uint8Array(1 + groupDeltaBytes.length + 3);
  secondEncoded[0] = secondFlags;
  secondEncoded.set(groupDeltaBytes, 1);
  secondEncoded[1 + groupDeltaBytes.length] = 0; // objectId
  secondEncoded[1 + groupDeltaBytes.length + 1] = 200; // priority
  secondEncoded[1 + groupDeltaBytes.length + 2] = 100; // payloadLength

  const [secondDecoded, , secondContext] = decodeFetchObjectFields(
    secondEncoded,
    firstContext,
    0,
    false,
  );
  assert.equal(secondDecoded.subgroupId, 0n); // Datagram なので 0n
  // Datagram 後も context の subgroupId は非 Datagram の値 5n を保持する
  assert.equal(secondContext.subgroupId, 5n);

  // オブジェクト 3: 非 Datagram (SUBGROUP_SAME)
  const thirdFlags =
    FetchSerializationFlags.SUBGROUP_SAME | FetchSerializationFlags.OBJECT_ID_PRESENT;
  const objectDeltaBytes = encodeVarint(2n);
  const payloadLengthBytes = encodeVarint(50n);
  const thirdEncoded = new Uint8Array(1 + objectDeltaBytes.length + payloadLengthBytes.length);
  thirdEncoded[0] = thirdFlags;
  thirdEncoded.set(objectDeltaBytes, 1);
  thirdEncoded.set(payloadLengthBytes, 1 + objectDeltaBytes.length);

  const [thirdDecoded] = decodeFetchObjectFields(thirdEncoded, secondContext, 0, false);
  // SUBGROUP_SAME → context の subgroupId (5n) が正しく伝搬
  assert.equal(thirdDecoded.subgroupId, 5n);
});

/**
 * createFirstFetchObjectFlags: Datagram 引数で DATAGRAM ビット付き flags を生成する。
 */
test("FetchObjectFields: createFirstFetchObjectFlags で Datagram 用 flags を生成できる", () => {
  const flags = createFirstFetchObjectFlags(false, true);

  assert.isOk(flags & FetchSerializationFlags.DATAGRAM);
  assert.isOk(flags & FetchSerializationFlags.GROUP_ID_PRESENT);
  assert.isOk(flags & FetchSerializationFlags.OBJECT_ID_PRESENT);
  assert.isOk(flags & FetchSerializationFlags.PRIORITY_PRESENT);
  // Datagram 時は SUBGROUP_PRESENT を含まない
  assert.isNotOk(
    (flags & FetchSerializationFlags.SUBGROUP_MASK) === FetchSerializationFlags.SUBGROUP_PRESENT,
  );
});

/**
 * encode → decode roundtrip: Datagram つきの先頭オブジェクト
 */
test("FetchObjectFields: Datagram 先頭オブジェクトの encode→decode roundtrip", () => {
  const flags = createFirstFetchObjectFlags(false, true);
  const original: FetchObjectFields = {
    serializationFlags: flags,
    groupId: 100n,
    subgroupId: 0n, // Datagram 時は 0n
    objectId: 50n,
    publisherPriority: 200,
    payloadLength: 1000n,
  };

  const encoded = encodeFetchObjectFields(original);
  const [decoded, , context] = decodeFetchObjectFields(encoded, null, 0, true);

  assert.equal(decoded.groupId, 100n);
  assert.equal(decoded.subgroupId, 0n);
  assert.equal(decoded.objectId, 50n);
  assert.equal(decoded.publisherPriority, 200);
  assert.equal(decoded.payloadLength, 1000n);
  assert.equal(context.subgroupId, 0n);
});

// ============================================================================
// Fetch Object Fields - Object ID オーバーフローチェックのテスト
// ============================================================================

/**
 * draft-ietf-moq-transport-18 §11.4.4.1 Table 9:
 * "If the computed Object ID would be greater than 2^64-1, the
 *  Subscriber MUST close the Session with error 'PROTOCOL_VIOLATION'."
 *
 * Object ID Delta なし（+1）で Object ID が overflow する場合。
 */
test("FetchObjectFields: Object ID +1 で 2^64-1 を超過する場合は ProtocolViolationError", () => {
  const prior: FetchObjectContext = {
    groupId: 5n,
    subgroupId: 1n,
    objectId: (1n << 64n) - 1n,
    publisherPriority: 128,
  };

  // SUBGROUP_SAME (OBJECT_ID_PRESENT なし → +1)
  const flags = FetchSerializationFlags.SUBGROUP_SAME;
  const payloadLengthBytes = encodeVarint(50n);

  const data = new Uint8Array(1 + payloadLengthBytes.length);
  data[0] = flags;
  data.set(payloadLengthBytes, 1);

  assert.throws(
    () => decodeFetchObjectFields(data, prior, 0, false),
    /computed object id out of range/,
  );
});

/**
 * Group 不変時の Object ID Delta で overflow する場合。
 * Prior: 2^64-2, delta: 3 → 2^64-2 + 3 = 2^64+1 > 2^64-1
 */
test("FetchObjectFields: Group 不変時の Object ID Delta で 2^64-1 を超過する場合は ProtocolViolationError", () => {
  const prior: FetchObjectContext = {
    groupId: 5n,
    subgroupId: 1n,
    objectId: (1n << 64n) - 2n,
    publisherPriority: 128,
  };

  const flags = FetchSerializationFlags.SUBGROUP_SAME | FetchSerializationFlags.OBJECT_ID_PRESENT;

  const objectDeltaBytes = encodeVarint(3n);
  const payloadLengthBytes = encodeVarint(50n);

  const data = new Uint8Array(1 + objectDeltaBytes.length + payloadLengthBytes.length);
  data[0] = flags;
  data.set(objectDeltaBytes, 1);
  data.set(payloadLengthBytes, 1 + objectDeltaBytes.length);

  assert.throws(
    () => decodeFetchObjectFields(data, prior, 0, false),
    /computed object id out of range/,
  );
});
