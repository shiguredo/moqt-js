import { test, assert } from "vitest";
import {
  SubgroupHeaderType,
  encodeSubgroupHeader,
  decodeSubgroupHeader,
  encodeObjectFields,
  decodeObjectFields,
  hasExtensionsPresent,
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
import { encodeVarint } from "./varint";

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

test("hasExtensionsPresent: 偶数タイプは Extensions Present = No", () => {
  assert.equal(hasExtensionsPresent(0x10), false);
  assert.equal(hasExtensionsPresent(0x12), false);
  assert.equal(hasExtensionsPresent(0x14), false);
});

test("hasExtensionsPresent: 奇数タイプは Extensions Present = Yes", () => {
  assert.equal(hasExtensionsPresent(0x11), true);
  assert.equal(hasExtensionsPresent(0x13), true);
  assert.equal(hasExtensionsPresent(0x15), true);
});

test("ObjectFields: Extensions なしタイプ (0x10) をエンコード", () => {
  const encoded = encodeObjectFields(1n, 50n, 0x10);

  assert.equal(encoded[0], 1);
  assert.equal(encoded[1], 50);
  assert.equal(encoded.length, 2);
});

test("ObjectFields: Extensions ありタイプ (0x11) をエンコード", () => {
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

test("ObjectFields: Extensions データ付き (0x11 タイプ) をエンコード", () => {
  const extensions = new Uint8Array([0xaa, 0xbb, 0xcc]);
  const encoded = encodeObjectFields(10n, 50n, 0x11, ObjectStatus.NORMAL, extensions);

  assert.equal(encoded[0], 10);
  assert.equal(encoded[1], 3);
  assert.deepEqual(encoded.slice(2, 5), extensions);
  assert.equal(encoded[5], 50);
});

test("ObjectFields: 大きな objectIdDelta と payloadLength をエンコード", () => {
  const encoded = encodeObjectFields(10000n, 100000n, 0x10);

  assert.isAbove(encoded.length, 2);
});

test("ObjectFields: Extensions なしタイプ (0x10) をデコード", () => {
  const data = new Uint8Array([0x01, 0x3f]);
  const [fields, consumed] = decodeObjectFields(data, 0x10);

  assert.equal(fields.objectIdDelta, 1n);
  assert.equal(fields.extensionsLength, 0);
  assert.equal(fields.payloadLength, 63n);
  assert.equal(consumed, 2);
});

test("ObjectFields: Extensions ありタイプ (0x11) をデコード", () => {
  const data = new Uint8Array([0x05, 0x03, 0xaa, 0xbb, 0xcc, 0x0a]);
  const [fields, consumed] = decodeObjectFields(data, 0x11);

  assert.equal(fields.objectIdDelta, 5n);
  assert.equal(fields.extensionsLength, 3);
  assert.deepEqual(fields.extensions, new Uint8Array([0xaa, 0xbb, 0xcc]));
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

test("ObjectFields: Extensions 付き roundtrip (0x11 タイプ)", () => {
  const extensions = new Uint8Array([0x11, 0x22, 0x33, 0x44, 0x55]);
  const encoded = encodeObjectFields(42n, 256n, 0x11, ObjectStatus.NORMAL, extensions);
  const [decoded, consumed] = decodeObjectFields(encoded, 0x11);

  assert.equal(decoded.objectIdDelta, 42n);
  assert.equal(decoded.extensionsLength, 5);
  assert.deepEqual(decoded.extensions, extensions);
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
 * draft-ietf-moq-transport-16:
 * OBJECT_DOES_NOT_EXIST (0x1) は削除された。
 * https://github.com/moq-wg/moq-transport/pull/1342
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
  assert.equal(hasExtensionsPresent(SubgroupHeaderType.BASE), false);
  assert.equal(hasExtensionsPresent(SubgroupHeaderType.BASE_EXT), true);
  assert.equal(hasExtensionsPresent(SubgroupHeaderType.BASE_END_GROUP), false);
  assert.equal(hasExtensionsPresent(SubgroupHeaderType.BASE_EXT_END_GROUP), true);

  assert.equal(hasExtensionsPresent(SubgroupHeaderType.BASE_NO_PRIORITY), false);
  assert.equal(hasExtensionsPresent(SubgroupHeaderType.BASE_EXT_NO_PRIORITY), true);
  assert.equal(hasExtensionsPresent(SubgroupHeaderType.BASE_END_GROUP_NO_PRIORITY), false);
  assert.equal(hasExtensionsPresent(SubgroupHeaderType.BASE_EXT_END_GROUP_NO_PRIORITY), true);
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

test("ObjectDatagram: PAYLOAD_OBJ_EXT タイプ (0x01) - Extensions 付きをエンコード", () => {
  const extensions = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
  const datagram: ObjectDatagram = {
    type: DatagramType.PAYLOAD_OBJ_EXT,
    trackAlias: 2n,
    groupId: 3n,
    objectId: 4n,
    publisherPriority: 200,
    extensions,
    payload: new Uint8Array([0x01]),
  };

  const encoded = encodeObjectDatagram(datagram);

  assert.equal(encoded[0], 0x01);
  assert.equal(encoded[5], 4);
  assert.deepEqual(encoded.slice(6, 10), extensions);
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

  assert.throws(() => decodeFetchHeader(data), "Invalid Fetch Header type");
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

test("FetchObjectFields: createFirstFetchObjectFlags で Extensions なしフラグを作成", () => {
  const flags = createFirstFetchObjectFlags(false);

  assert.isOk(flags & FetchSerializationFlags.GROUP_ID_PRESENT);
  assert.equal(
    flags & FetchSerializationFlags.SUBGROUP_MASK,
    FetchSerializationFlags.SUBGROUP_PRESENT,
  );
  assert.isOk(flags & FetchSerializationFlags.OBJECT_ID_PRESENT);
  assert.isOk(flags & FetchSerializationFlags.PRIORITY_PRESENT);
  assert.isNotOk(flags & FetchSerializationFlags.EXTENSIONS_PRESENT);
});

test("FetchObjectFields: createFirstFetchObjectFlags で Extensions ありフラグを作成", () => {
  const flags = createFirstFetchObjectFlags(true);

  assert.isOk(flags & FetchSerializationFlags.EXTENSIONS_PRESENT);
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

test("FetchObjectFields: status 付き (payload length = 0) をエンコード", () => {
  const flags = createFirstFetchObjectFlags(false);
  const fields: FetchObjectFields = {
    serializationFlags: flags,
    groupId: 1n,
    subgroupId: 0n,
    objectId: 0n,
    publisherPriority: 100,
    payloadLength: 0n,
    status: ObjectStatus.END_OF_GROUP,
  };

  const encoded = encodeFetchObjectFields(fields);
  const lastByte = encoded[encoded.length - 1];

  assert.equal(lastByte, ObjectStatus.END_OF_GROUP);
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

test("FetchObjectFields: 予約ビット使用でエラー", () => {
  const flags = 0x40;
  const data = new Uint8Array([flags, 1, 0, 0, 0, 10]);

  assert.throws(
    () => decodeFetchObjectFields(data, null, 0, true),
    "Protocol violation: reserved bits 0x40 or 0x80 are set",
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
    "Protocol violation: First object must have GROUP_ID_PRESENT flag set",
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
 * draft-ietf-moq-transport-16:
 * 同一 Subgroup 内のオブジェクトは同じ Priority を持つ必要がある。
 * https://github.com/moq-wg/moq-transport/pull/1317
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
