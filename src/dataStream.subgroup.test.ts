/**
 * MOQT データストリーム Subgroup テスト
 * draft-ietf-moq-transport-21 Section 11.3.1 (Subgroup Header)
 */

import { test, assert } from "vite-plus/test";
import {
  SubgroupHeaderType,
  encodeSubgroupHeader,
  decodeSubgroupHeader,
  encodeObjectFields,
  decodeObjectFields,
  hasPropertiesPresent,
  hasEndOfGroup,
} from "./dataStream";
import { ObjectStatus } from "./message/types";
import {
  IncompleteDataError,
  MalformedTrackError,
  ProtocolViolationError,
  SessionError,
} from "./error";
import { encodeProperties, MOQTPropertyId } from "./properties";
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

/**
 * draft-ietf-moq-transport-21 §11.3.1:
 * Priority Present (DEFAULT_PRIORITY bit = 0) の型で publisherPriority が
 * 省略された場合、エラーを throw することを検証する。
 * SUBGROUP_ID_MODE により Subgroup ID フィールドが先にエンコードされる
 * EXPLICIT 型でも省略を黙過せず throw される。
 */
test("SubgroupHeader: Priority Present の型で publisherPriority 省略は throw する", () => {
  assert.throws(
    () =>
      encodeSubgroupHeader({
        type: SubgroupHeaderType.BASE,
        trackAlias: 1n,
        groupId: 1n,
      }),
    /publisherPriority is required when Priority Present bit is set/,
  );
  assert.throws(
    () =>
      encodeSubgroupHeader({
        type: SubgroupHeaderType.EXPLICIT,
        trackAlias: 1n,
        groupId: 1n,
        subgroupId: 0n,
      }),
    /publisherPriority is required when Priority Present bit is set/,
  );
});

/**
 * draft-ietf-moq-transport-21 §11.3.1:
 * Publisher Priority は 8 bit (0〜255) であり、範囲外・非整数は
 * Uint8Array 化で黙って丸められるため、変換前に throw することを検証する。
 */
test("SubgroupHeader: 範囲外・非整数の publisherPriority は throw する", () => {
  // 256 以上・負値・300 (丸めで 44 になる値) はいずれも拒否する
  for (const priority of [256, -1, 300]) {
    assert.throws(
      () =>
        encodeSubgroupHeader({
          type: SubgroupHeaderType.BASE,
          trackAlias: 1n,
          groupId: 1n,
          publisherPriority: priority,
        }),
      /invalid publisher priority: .* expected integer 0 to 255/,
    );
  }
  // 非整数も拒否する
  for (const priority of [1.5, Number.NaN]) {
    assert.throws(
      () =>
        encodeSubgroupHeader({
          type: SubgroupHeaderType.BASE,
          trackAlias: 1n,
          groupId: 1n,
          publisherPriority: priority,
        }),
      /invalid publisher priority/,
    );
  }
  // 境界値 0 / 255 は従来どおり通る
  for (const priority of [0, 255]) {
    const encoded = encodeSubgroupHeader({
      type: SubgroupHeaderType.BASE,
      trackAlias: 1n,
      groupId: 1n,
      publisherPriority: priority,
    });
    assert.equal(encoded[encoded.length - 1], priority);
  }
});

/**
 * draft-ietf-moq-transport-21 §11.3.1:
 * Priority なし型では不正値が渡されても検証せず throw しないことを検証する。
 * (検証は Priority Present 分岐内でのみ行う)
 */
test("SubgroupHeader: Priority なし型では範囲外 priority でも throw しない", () => {
  const encoded = encodeSubgroupHeader({
    type: SubgroupHeaderType.BASE_NO_PRIORITY,
    trackAlias: 1n,
    groupId: 1n,
    publisherPriority: 300,
  });
  assert.isDefined(encoded);
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

// draft-ietf-moq-transport-21 Section 11.3.1:
// SUBGROUP_ID_MODE = 0b11 のタイプ値は予約済みであり、受信側は PROTOCOL_VIOLATION で
// セッションを閉じなければならない
for (const reservedType of [0x16, 0x17, 0x1e, 0x1f, 0x36, 0x37, 0x3e, 0x3f]) {
  test(`SubgroupHeader: 予約値 0x${reservedType.toString(16)} は ProtocolViolationError`, () => {
    const data = new Uint8Array([reservedType, 0x01, 0x02, 0x80]);
    assert.throws(() => decodeSubgroupHeader(data), ProtocolViolationError);
    assert.throws(() => decodeSubgroupHeader(data), /SUBGROUP_ID_MODE 0b11 is reserved/);
  });
}

// draft-ietf-moq-transport-21 Section 11.3.1:
// "Values of 128 or greater ... MUST close the session with a PROTOCOL_VIOLATION"
// のため、bit 7 の有無に関わらず 128 以上はすべて拒否する
for (const invalidType of [0x80, 0x100, 0x110]) {
  test(`SubgroupHeader: 128 以上の型 0x${invalidType.toString(16)} は ProtocolViolationError`, () => {
    const bytes: number[] = [];
    if (invalidType < 0x40) {
      bytes.push(invalidType);
    } else if (invalidType < 0x4000) {
      // QUIC varint 2 バイト形式
      bytes.push(0x40 | (invalidType >> 8), invalidType & 0xff);
    } else {
      // QUIC varint 4 バイト形式
      bytes.push(
        0x80 | (invalidType >>> 24),
        (invalidType >> 16) & 0xff,
        (invalidType >> 8) & 0xff,
        invalidType & 0xff,
      );
    }
    // trackAlias と groupId を続け、型検証まで到達させる
    bytes.push(0x01, 0x02);
    const data = new Uint8Array(bytes);
    assert.throws(() => decodeSubgroupHeader(data), ProtocolViolationError);
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

/**
 * draft-ietf-moq-transport-21 §11.3.1:
 * Priority Present の型で Priority バイトがバッファの最後で切れている場合、
 * 範囲外アクセス (undefined 取得) による誤デコード (残りバイト列のフィールド
 * ずれ) を避け、IncompleteDataError を throw して次のチャンクを待つことを
 * 検証する。
 */
test("SubgroupHeader: Priority バイトでバッファが切れていると IncompleteDataError", () => {
  // type(0x10: BASE, Priority Present) + trackAlias + groupId のみで
  // Priority バイトが欠落している
  const data = new Uint8Array([0x10, 0x05, 0x0a]);
  assert.throws(() => decodeSubgroupHeader(data), IncompleteDataError);
});

// draft-ietf-moq-transport-21 Section 11.3.1:
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
  // draft-ietf-moq-transport-21 Section 11.3.1:
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

/**
 * draft-ietf-moq-transport-21 §3.6:
 * Object Property に Mandatory Track Property (0x4000-0x7FFF) を含む Object は
 * malformed であり、decodeObjectFields が MalformedTrackError を throw する。
 */
test("ObjectFields: Mandatory Track Property を含む Object Property で MalformedTrackError", () => {
  const properties = encodeProperties([{ id: 0x4000n, value: 0n }]);
  const encoded = encodeObjectFields(1n, 0n, 0x11, ObjectStatus.NORMAL, properties);
  assert.throws(() => decodeObjectFields(encoded, 0x11), MalformedTrackError);
});

/**
 * draft-ietf-moq-transport-21 §10.8:
 * "An Object contains more than one instance of Prior Group ID Gap." → malformed
 * 同一 Object に PRIOR_GROUP_ID_GAP が 2 回現れる場合も decodeObjectFields で検出する。
 */
test("ObjectFields: PRIOR_GROUP_ID_GAP の複数出現で MalformedTrackError", () => {
  const properties = encodeProperties([
    { id: MOQTPropertyId.PRIOR_GROUP_ID_GAP, value: 0n },
    { id: MOQTPropertyId.PRIOR_GROUP_ID_GAP, value: 0n },
  ]);
  const encoded = encodeObjectFields(1n, 0n, 0x11, ObjectStatus.NORMAL, properties);
  assert.throws(
    () => decodeObjectFields(encoded, 0x11),
    MalformedTrackError,
    "Object contains more than one instance of PRIOR_GROUP_ID_GAP",
  );
});

/**
 * draft-ietf-moq-transport-21 §10.7 / §10.8:
 * mutable list と IMMUTABLE_PROPERTIES 配下を合わせて 2 回現れる場合も malformed とする。
 */
/**
 * draft-ietf-moq-transport-21 §8.3:
 * "If a receiver understands a Type, and the following Value or Length/Value
 *  does not match the serialization defined by that Type, the receiver MUST
 *  close the session with error code KEY_VALUE_FORMATTING_ERROR."
 * 既知 Type の Value が varint として完結しない Object を検出する。
 */
test("ObjectFields: 既知 Type の Value 不一致で KEY_VALUE_FORMATTING_ERROR", () => {
  // deltaId=0x02 (OBJECT_DELIVERY_TIMEOUT), value=0x80 (varint が完結しない)
  const properties = new Uint8Array([0x02, 0x80]);
  const encoded = encodeObjectFields(1n, 0n, 0x11, ObjectStatus.NORMAL, properties);
  assert.throws(
    () => decodeObjectFields(encoded, 0x11),
    SessionError,
    /key-value-pair value does not match serialization/,
  );
});

/**
 * draft-ietf-moq-transport-21 §8.3:
 * 既知 Type の Length 宣言が残りバイトを超える Object を検出する。
 */
test("ObjectFields: 既知 Type の Length 宣言超過で KEY_VALUE_FORMATTING_ERROR", () => {
  // deltaId=0x0B (IMMUTABLE_PROPERTIES), length=5 宣言 + 2 バイトの切り詰め
  const properties = new Uint8Array([0x0b, 0x05, 0xaa, 0xbb]);
  const encoded = encodeObjectFields(1n, 0n, 0x11, ObjectStatus.NORMAL, properties);
  assert.throws(
    () => decodeObjectFields(encoded, 0x11),
    SessionError,
    /key-value-pair value does not match serialization/,
  );
});

test("ObjectFields: mutable と IMMUTABLE_PROPERTIES の合算 2 回の PRIOR_GROUP_ID_GAP で MalformedTrackError", () => {
  const inner = encodeProperties([{ id: MOQTPropertyId.PRIOR_GROUP_ID_GAP, value: 0n }]);
  const properties = encodeProperties([
    { id: MOQTPropertyId.IMMUTABLE_PROPERTIES, data: inner },
    { id: MOQTPropertyId.PRIOR_GROUP_ID_GAP, value: 0n },
  ]);
  const encoded = encodeObjectFields(1n, 0n, 0x11, ObjectStatus.NORMAL, properties);
  assert.throws(
    () => decodeObjectFields(encoded, 0x11),
    MalformedTrackError,
    "Object contains more than one instance of PRIOR_GROUP_ID_GAP",
  );
});

/**
 * draft-ietf-moq-transport-21 §11.1.3 / §3.6:
 * non-Normal status の Object に properties がある場合は PROTOCOL_VIOLATION で
 * セッションを閉じる MUST を優先し、Mandatory Track Property の検出より先に
 * 検証することを検証する。
 */
test("ObjectFields: non-Normal status + properties は Mandatory 検出より先に ProtocolViolationError", () => {
  const properties = encodeProperties([{ id: 0x4000n, value: 0n }]);
  const data = new Uint8Array([
    0x00,
    ...encodeVarint(properties.length),
    ...properties,
    0x00,
    ...encodeVarint(ObjectStatus.END_OF_TRACK),
  ]);
  assert.throws(() => decodeObjectFields(data, 0x11), ProtocolViolationError);
});

/**
 * draft-ietf-moq-transport-21 Section 11.3.1:
 * Properties Length が宣言するバイト数にバッファが満たない場合、
 * 切り詰めた Properties を返して後続フィールドを誤読せず、
 * IncompleteDataError を throw して次のチャンクを待つ。
 */
test("ObjectFields: Properties バイト列途中でバッファが切れていると IncompleteDataError", () => {
  // objectIdDelta(0x05) + Properties Length(0x03) までは揃うが
  // Properties 本体が 2 バイトしかない
  const data = new Uint8Array([0x05, 0x03, 0xaa, 0xbb]);
  assert.throws(() => decodeObjectFields(data, 0x11), IncompleteDataError, "properties");
});

test("ObjectFields: Properties 不足時に後続バイトを盗まず IncompleteDataError", () => {
  // 宣言 4 に対し実 2 バイト + 後続の Object Payload Length(0x0a) がある形。
  // 境界検査なしでは 0x0a を Properties 3 バイト目として盗み
  // totalConsumed を過剰に進めて後続を誤読する
  const data = new Uint8Array([0x05, 0x04, 0xaa, 0xbb, 0x0a]);
  assert.throws(() => decodeObjectFields(data, 0x11), IncompleteDataError, "properties");
});

test("ObjectFields: オフセット付きで Properties 不足の場合は IncompleteDataError", () => {
  const data = new Uint8Array([0xff, 0xff, 0x05, 0x03, 0xaa, 0xbb]);
  assert.throws(() => decodeObjectFields(data, 0x11, 2), IncompleteDataError, "properties");
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

/**
 * draft-ietf-moq-transport-21:
 * OBJECT_DOES_NOT_EXIST (0x1) は削除された。
 * draft-ietf-moq-transport-21 Section 11.1.2
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
  assert.equal(hasEndOfGroup(SubgroupHeaderType.BASE), false);
  assert.equal(hasEndOfGroup(SubgroupHeaderType.EXPLICIT), false);
  assert.equal(hasEndOfGroup(SubgroupHeaderType.BASE_NO_PRIORITY), false);
  assert.equal(hasEndOfGroup(SubgroupHeaderType.EXPLICIT_NO_PRIORITY), false);

  assert.equal(hasEndOfGroup(SubgroupHeaderType.BASE_END_GROUP), true);
  assert.equal(hasEndOfGroup(SubgroupHeaderType.EXPLICIT_END_GROUP), true);
  assert.equal(hasEndOfGroup(SubgroupHeaderType.BASE_END_GROUP_NO_PRIORITY), true);
  assert.equal(hasEndOfGroup(SubgroupHeaderType.EXPLICIT_END_GROUP_NO_PRIORITY), true);
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

test("SubgroupHeaderType: No Priority + firstObject タイプの roundtrip テスト", () => {
  // TYPE はワイヤ上で 0x40 が OR されるが (0x70 系)、Priority Present では
  // ないため Priority フィールドはエンコードされず、publisherPriority なしで
  // エンコードできる (完了条件 2 の No Priority 側の回帰ガード)。
  const header = {
    type: SubgroupHeaderType.BASE_NO_PRIORITY,
    trackAlias: 10n,
    groupId: 20n,
    firstObject: true,
  };

  const encoded = encodeSubgroupHeader(header);
  const [decoded, consumed] = decodeSubgroupHeader(encoded);

  assert.equal(decoded.type, SubgroupHeaderType.BASE_NO_PRIORITY | 0x40);
  assert.equal(decoded.trackAlias, 10n);
  assert.equal(decoded.groupId, 20n);
  assert.equal(decoded.subgroupId, 0n);
  assert.equal(decoded.firstObject, true);
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

test("SubgroupHeader: FIRST_OBJECT ビットを設定したエンコード", () => {
  // draft-ietf-moq-transport-21 §11.3.1:
  // 新しい subgroup の最初のオブジェクトには FIRST_OBJECT ビット (0x40) を設定する (MUST)
  const header = {
    type: SubgroupHeaderType.FIRST_OBJ_EXT,
    trackAlias: 5n,
    groupId: 10n,
    publisherPriority: 128,
    firstObject: true,
  };

  const encoded = encodeSubgroupHeader(header);

  // type バイトは FIRST_OBJ_EXT (0x13) | FIRST_OBJECT (0x40) = 0x53
  assert.equal(encoded[0], 0x53);
});

test("SubgroupHeader: FIRST_OBJECT ビット付きエンコードのデコード roundtrip", () => {
  const header = {
    type: SubgroupHeaderType.FIRST_OBJ_EXT,
    trackAlias: 42n,
    groupId: 99n,
    publisherPriority: 200,
    firstObject: true,
  };

  const encoded = encodeSubgroupHeader(header);
  const [decoded, consumed] = decodeSubgroupHeader(encoded);

  // デコード後の type は FIRST_OBJECT ビットを含む
  assert.equal(decoded.type, SubgroupHeaderType.FIRST_OBJ_EXT | 0x40);
  assert.equal(decoded.firstObject, true);
  assert.equal(decoded.trackAlias, 42n);
  assert.equal(decoded.groupId, 99n);
  assert.equal(decoded.publisherPriority, 200);
  assert.equal(consumed, encoded.length);
});

// draft-ietf-moq-transport-21 §11.3.1 (END_OF_GROUP bit 0x08):
// "The END_OF_GROUP bit (0x08) indicates that this subgroup contains the
//  largest Object in the Group."
// デコード時に endOfGroup を公開し、エンコードでも指定できることを検証する。
test("SubgroupHeader: END_OF_GROUP ビットを公開する", () => {
  // BASE_END_GROUP (0x18) は END_OF_GROUP ビットを含む
  const data = new Uint8Array([0x18, 0x05, 0x0a, 0x80]);
  const [header, consumed] = decodeSubgroupHeader(data);

  assert.equal(header.type, SubgroupHeaderType.BASE_END_GROUP);
  assert.equal(header.endOfGroup, true);
  assert.equal(header.firstObject, undefined);
  assert.equal(consumed, 4);

  // END_OF_GROUP ビットを含まない型では undefined
  const [plain] = decodeSubgroupHeader(new Uint8Array([0x10, 0x05, 0x0a, 0x80]));
  assert.isUndefined(plain.endOfGroup);
});

test("SubgroupHeader: endOfGroup 指定で END_OF_GROUP ビットが OR される", () => {
  const encoded = encodeSubgroupHeader({
    type: SubgroupHeaderType.FIRST_OBJ_EXT,
    trackAlias: 5n,
    groupId: 10n,
    publisherPriority: 128,
    firstObject: true,
    endOfGroup: true,
  });

  // FIRST_OBJ_EXT (0x13) | FIRST_OBJECT (0x40) | END_OF_GROUP (0x08) = 0x5B
  assert.equal(encoded[0], 0x5b);

  const [decoded, consumed] = decodeSubgroupHeader(encoded);
  assert.equal(decoded.endOfGroup, true);
  assert.equal(decoded.firstObject, true);
  assert.equal(consumed, encoded.length);
});

test("SubgroupHeader: endOfGroup 未指定では END_OF_GROUP ビットが OR されない", () => {
  const encoded = encodeSubgroupHeader({
    type: SubgroupHeaderType.FIRST_OBJ_EXT,
    trackAlias: 5n,
    groupId: 10n,
    publisherPriority: 128,
    firstObject: true,
  });

  assert.equal(encoded[0], 0x53);
  const [decoded] = decodeSubgroupHeader(encoded);
  assert.isUndefined(decoded.endOfGroup);
});

test("encodeObjectFields: END_OF_GROUP ステータスをエンコードできる", () => {
  // draft-ietf-moq-transport-21 §11.1.2:
  // END_OF_GROUP ステータスはペイロード長 0 の場合にエンコードされる
  const data = encodeObjectFields(
    0n,
    0n,
    SubgroupHeaderType.FIRST_OBJ_EXT,
    ObjectStatus.END_OF_GROUP,
  );

  // Object ID Delta (0) + Ext Length (0) + Payload Length (0) + Status (END_OF_GROUP=3)
  assert.equal(data[0], 0); // Object ID Delta = 0
  assert.equal(data[1], 0); // Ext Length = 0
  assert.equal(data[2], 0); // Payload Length = 0
  assert.equal(data[3], ObjectStatus.END_OF_GROUP);
});

test("encodeObjectFields: END_OF_TRACK ステータスをエンコードできる", () => {
  const data = encodeObjectFields(
    0n,
    0n,
    SubgroupHeaderType.FIRST_OBJ_EXT,
    ObjectStatus.END_OF_TRACK,
  );

  assert.equal(data[3], ObjectStatus.END_OF_TRACK);
});

test("encodeObjectFields: NORMAL ステータスでペイロード長 0 の場合 status=0 がエンコードされる", () => {
  const data = encodeObjectFields(0n, 0n, SubgroupHeaderType.FIRST_OBJ_EXT, ObjectStatus.NORMAL);

  assert.equal(data[3], ObjectStatus.NORMAL);
});

test("encodeObjectFields: END_OF_GROUP + 非空 properties は ProtocolViolationError", () => {
  assert.throws(
    () =>
      encodeObjectFields(
        0n,
        0n,
        SubgroupHeaderType.FIRST_OBJ_EXT,
        ObjectStatus.END_OF_GROUP,
        new Uint8Array([1, 2, 3]),
      ),
    ProtocolViolationError,
  );
});

test("encodeObjectFields: END_OF_GROUP + 非空 payload は ProtocolViolationError", () => {
  assert.throws(
    () => encodeObjectFields(0n, 1n, SubgroupHeaderType.FIRST_OBJ_EXT, ObjectStatus.END_OF_GROUP),
    ProtocolViolationError,
  );
});
