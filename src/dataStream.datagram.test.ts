/**
 * MOQT データストリーム Datagram テスト
 * draft-ietf-moq-transport-19 Section 11.3 (Datagrams)
 */

import { test, assert } from "vite-plus/test";
import {
  DatagramType,
  type ObjectDatagram,
  encodeObjectDatagram,
  decodeObjectDatagram,
} from "./dataStream";
import { ObjectStatus } from "./message/types";
import { appendGreaseObjectProperty } from "./properties";
import { isGreaseValue } from "./grease";
import { decodeVarint } from "./varint";

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
  // draft-ietf-moq-transport-19 Section 11.3.1:
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

// Object Properties の absolute TLV（Type + Length + Value）から Property ID の一覧を抽出する。
function parseObjectPropertyIds(bytes: Uint8Array): bigint[] {
  const ids: bigint[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const [type, typeLen] = decodeVarint(bytes, offset);
    offset += typeLen;
    const [len, lenLen] = decodeVarint(bytes, offset);
    offset += lenLen + Number(len);
    ids.push(type);
  }
  return ids;
}

// draft-ietf-moq-transport-19 §14 (Grease):
// grease opt-in 時、Object Properties に GREASE Property を 1 つ注入する。
// 元々 properties がない datagram でも Properties Present ビット（Datagram Type bit 0）が
// 立った EXT 型となり、GREASE Property がラウンドトリップすることを検証する。
test("ObjectDatagram: GREASE Object Properties が EXT 型でラウンドトリップする", () => {
  for (let i = 0; i < 20; i++) {
    const greaseProperties = appendGreaseObjectProperty(undefined);
    const datagram: ObjectDatagram = {
      type: DatagramType.PAYLOAD_OBJ_EXT,
      trackAlias: 1n,
      groupId: 2n,
      objectId: 3n,
      publisherPriority: 128,
      properties: greaseProperties,
      payload: new Uint8Array([0xaa]),
    };

    const encoded = encodeObjectDatagram(datagram);
    const [decoded] = decodeObjectDatagram(encoded);

    // Properties Present ビット（bit 0）が立っていること
    assert.equal(decoded.type & 0x01, 0x01);
    // 注入した GREASE Properties バイト列が保持されること
    assert.deepEqual(decoded.properties, greaseProperties);
    // properties 内に GREASE 予約値（0x4000 未満）が 1 つ含まれること
    const ids = parseObjectPropertyIds(decoded.properties ?? new Uint8Array(0));
    assert.equal(ids.length, 1);
    assert.isTrue(isGreaseValue(ids[0]));
    assert.isTrue(ids[0] < 0x4000n);
  }
});
