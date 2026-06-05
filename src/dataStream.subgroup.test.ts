/**
 * MOQT データストリーム Subgroup テスト
 * draft-ietf-moq-transport-18 Section 11.4.2 (Subgroup Header)
 */

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
} from "./dataStream";
import { ObjectStatus } from "./message/types";
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
