/**
 * MOQT Extension Headers Unit Tests
 * draft-ietf-moq-transport-16 Section 11
 */

import { test, assert } from "vitest";
import {
  encodeProperty,
  encodeProperties,
  encodeImmutableProperties,
  decodeImmutableProperties,
  parseProperties,
  MOQTPropertyId,
  type Property,
} from "./properties";

test("encodeProperty: 偶数 ID は varint value 形式でエンコード", () => {
  const header: Property = { id: 0x02n, value: 42n };
  const encoded = encodeProperty(header);

  // ID: 0x02 (1 byte) + value: 42 (1 byte, varint で 42 < 64 なので 1 バイト)
  assert.equal(encoded[0], 0x02);
  assert.equal(encoded[1], 42);
});

test("encodeProperty: 奇数 ID は length + bytes 形式でエンコード", () => {
  const header: Property = { id: 0x03n, data: new Uint8Array([0xaa, 0xbb, 0xcc]) };
  const encoded = encodeProperty(header);

  // ID: 0x03 (1 byte) + length: 3 (1 byte) + data: 3 bytes
  assert.equal(encoded[0], 0x03);
  assert.equal(encoded[1], 3);
  assert.deepEqual(encoded.subarray(2), new Uint8Array([0xaa, 0xbb, 0xcc]));
});

test("encodeProperty: 偶数 ID で value がない場合はエラー", () => {
  const header: Property = { id: 0x02n };
  assert.throws(() => encodeProperty(header), /requires a value/);
});

test("encodeProperty: 奇数 ID で data がない場合はエラー", () => {
  const header: Property = { id: 0x03n };
  assert.throws(() => encodeProperty(header), /requires data/);
});

/**
 * draft-ietf-moq-transport-16:
 * delta encoding を使用するため、ID は前の ID からの差分としてエンコードされる。
 */
test("encodeProperties: 複数の拡張を delta encoding でエンコードして結合", () => {
  const headers: Property[] = [
    { id: 0x02n, value: 42n },
    { id: 0x03n, data: new Uint8Array([0xff]) },
  ];
  const encoded = encodeProperties(headers);

  // delta encoding: delta(0x02)=0x02, value=42, delta(0x03-0x02)=0x01, length=1, data=0xff
  assert.equal(encoded.length, 5);
  assert.equal(encoded[0], 0x02);
  assert.equal(encoded[1], 42);
  assert.equal(encoded[2], 0x01);
  assert.equal(encoded[3], 1);
  assert.equal(encoded[4], 0xff);
});

test("encodeImmutableProperties: 空の拡張リスト", () => {
  const immutable = { extensions: [] };
  const encoded = encodeImmutableProperties(immutable);

  // ID: 0x0B (1 byte) + length: 0 (1 byte)
  assert.equal(encoded[0], 0x0b);
  assert.equal(encoded[1], 0);
  assert.equal(encoded.length, 2);
});

test("encodeImmutableProperties: 単一の偶数 ID 拡張", () => {
  const immutable = {
    extensions: [{ id: 0x04n, value: 12345n }],
  };
  const encoded = encodeImmutableProperties(immutable);

  // ID: 0x0B + length + (ID: 0x04 + value: 12345)
  assert.equal(encoded[0], 0x0b);
  // 内部: 0x04 (1 byte) + 12345 = 0x4039 (2 bytes) = 3 bytes
  assert.equal(encoded[1], 3);
});

test("encodeImmutableProperties: 単一の奇数 ID 拡張", () => {
  const data = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
  const immutable = {
    extensions: [{ id: 0x05n, data }],
  };
  const encoded = encodeImmutableProperties(immutable);

  // ID: 0x0B + length + (ID: 0x05 + length: 4 + data: 4 bytes)
  assert.equal(encoded[0], 0x0b);
  // 内部: 0x05 (1 byte) + 4 (1 byte) + data (4 bytes) = 6 bytes
  assert.equal(encoded[1], 6);
});

test("encodeImmutableProperties: 複数の拡張", () => {
  const immutable = {
    extensions: [
      { id: 0x02n, value: 10n },
      { id: 0x03n, data: new Uint8Array([0xaa, 0xbb]) },
      { id: 0x04n, value: 20n },
    ],
  };
  const encoded = encodeImmutableProperties(immutable);

  // ID: 0x0B + length + 内部データ
  assert.equal(encoded[0], 0x0b);
  // 内部: (0x02, 10) + (0x03, 2, 0xaa, 0xbb) + (0x04, 20)
  // = 2 + 4 + 2 = 8 bytes (varint で 10, 20 < 64 なので各 1 バイト)
  assert.equal(encoded[1], 8);
});

test("decodeImmutableProperties: 空の拡張リスト", () => {
  const encoded = new Uint8Array([0x0b, 0x00]);
  const decoded = decodeImmutableProperties(encoded);

  assert.deepEqual(decoded.extensions, []);
});

test("decodeImmutableProperties: 単一の偶数 ID 拡張", () => {
  // ID: 0x0B, length: 2, (ID: 0x02, value: 42)
  const encoded = new Uint8Array([0x0b, 0x02, 0x02, 42]);
  const decoded = decodeImmutableProperties(encoded);

  assert.equal(decoded.extensions.length, 1);
  assert.equal(decoded.extensions[0].id, 0x02n);
  assert.equal(decoded.extensions[0].value, 42n);
});

test("decodeImmutableProperties: 単一の奇数 ID 拡張", () => {
  // ID: 0x0B, length: 5, (ID: 0x03, length: 3, data: 0xaa, 0xbb, 0xcc)
  const encoded = new Uint8Array([0x0b, 0x05, 0x03, 0x03, 0xaa, 0xbb, 0xcc]);
  const decoded = decodeImmutableProperties(encoded);

  assert.equal(decoded.extensions.length, 1);
  assert.equal(decoded.extensions[0].id, 0x03n);
  assert.deepEqual(decoded.extensions[0].data, new Uint8Array([0xaa, 0xbb, 0xcc]));
});

test("encodeImmutableProperties と decodeImmutableProperties のラウンドトリップ: 空", () => {
  const original = { extensions: [] };
  const encoded = encodeImmutableProperties(original);
  const decoded = decodeImmutableProperties(encoded);

  assert.deepEqual(decoded.extensions, original.extensions);
});

test("encodeImmutableProperties と decodeImmutableProperties のラウンドトリップ: 偶数 ID", () => {
  const original = {
    extensions: [{ id: 0x02n, value: 12345n }],
  };
  const encoded = encodeImmutableProperties(original);
  const decoded = decodeImmutableProperties(encoded);

  assert.equal(decoded.extensions.length, 1);
  assert.equal(decoded.extensions[0].id, 0x02n);
  assert.equal(decoded.extensions[0].value, 12345n);
});

test("encodeImmutableProperties と decodeImmutableProperties のラウンドトリップ: 奇数 ID", () => {
  const original = {
    extensions: [{ id: 0x03n, data: new Uint8Array([0x01, 0x02, 0x03]) }],
  };
  const encoded = encodeImmutableProperties(original);
  const decoded = decodeImmutableProperties(encoded);

  assert.equal(decoded.extensions.length, 1);
  assert.equal(decoded.extensions[0].id, 0x03n);
  assert.deepEqual(decoded.extensions[0].data, new Uint8Array([0x01, 0x02, 0x03]));
});

test("encodeImmutableProperties と decodeImmutableProperties のラウンドトリップ: 複合", () => {
  const original = {
    extensions: [
      { id: 0x02n, value: 100n },
      { id: 0x03n, data: new Uint8Array([0xaa, 0xbb]) },
      { id: 0x04n, value: 200n },
    ],
  };
  const encoded = encodeImmutableProperties(original);
  const decoded = decodeImmutableProperties(encoded);

  assert.equal(decoded.extensions.length, 3);
  assert.equal(decoded.extensions[0].id, 0x02n);
  assert.equal(decoded.extensions[0].value, 100n);
  assert.equal(decoded.extensions[1].id, 0x03n);
  assert.deepEqual(decoded.extensions[1].data, new Uint8Array([0xaa, 0xbb]));
  assert.equal(decoded.extensions[2].id, 0x04n);
  assert.equal(decoded.extensions[2].value, 200n);
});

test("parseProperties: Immutable Extensions を正しくパース", () => {
  // Immutable Extensions のみ
  const immutable = encodeImmutableProperties({
    extensions: [
      { id: 0x02n, value: 42n },
      { id: 0x05n, data: new Uint8Array([0x01, 0x02]) },
    ],
  });

  const parsed = parseProperties(immutable);

  assert.isDefined(parsed.immutableProperties);
  assert.equal(parsed.immutableProperties?.extensions.length, 2);
  assert.equal(parsed.immutableProperties?.extensions[0].id, 0x02n);
  assert.equal(parsed.immutableProperties?.extensions[0].value, 42n);
  assert.equal(parsed.immutableProperties?.extensions[1].id, 0x05n);
  assert.deepEqual(parsed.immutableProperties?.extensions[1].data, new Uint8Array([0x01, 0x02]));
});

/**
 * draft-ietf-moq-transport-16:
 * delta encoding を使用するため、複数の拡張は encodeProperties でエンコードする。
 */
test("parseProperties: Immutable Extensions と他の拡張の組み合わせ", () => {
  // Immutable Extensions の内部データ
  const innerExtensions = encodeProperties([{ id: 0x10n, value: 999n }]);

  // Prior Group ID Gap (0x3c) + Immutable Extensions (0x0b) + Prior Object ID Gap (0x3e)
  // encodeProperties は ID の昇順でソートするため、
  // 順序は IMMUTABLE_EXTENSIONS (0x0b), PRIOR_GROUP_ID_GAP (0x3c), PRIOR_OBJECT_ID_GAP (0x3e)
  const headers: Property[] = [
    { id: MOQTPropertyId.PRIOR_GROUP_ID_GAP, value: 3n },
    { id: MOQTPropertyId.IMMUTABLE_EXTENSIONS, data: innerExtensions },
    { id: MOQTPropertyId.PRIOR_OBJECT_ID_GAP, value: 5n },
  ];

  const encoded = encodeProperties(headers);
  const parsed = parseProperties(encoded);

  assert.equal(parsed.priorGroupIdGap?.gap, 3n);
  assert.equal(parsed.priorObjectIdGap?.gap, 5n);
  assert.isDefined(parsed.immutableProperties);
  assert.equal(parsed.immutableProperties?.extensions.length, 1);
  assert.equal(parsed.immutableProperties?.extensions[0].id, 0x10n);
  assert.equal(parsed.immutableProperties?.extensions[0].value, 999n);
});

test("parseProperties: Immutable Extensions が unknownProperties に含まれない", () => {
  const immutable = encodeImmutableProperties({
    extensions: [{ id: 0x02n, value: 1n }],
  });

  const parsed = parseProperties(immutable);

  // Immutable Extensions は unknownProperties に含まれない
  assert.isUndefined(parsed.unknownProperties);
  assert.isDefined(parsed.immutableProperties);
});

/**
 * draft-ietf-moq-transport-16:
 * delta encoding を使用するため、複数の拡張は encodeProperties でエンコードする。
 */
test("parseProperties: 全ての MOQT Core Extensions を正しくパース", () => {
  // Immutable Extensions の内部データ
  const innerExtensions = encodeProperties([
    { id: 0x100n, value: 500n },
    { id: 0x101n, data: new Uint8Array([0xde, 0xad, 0xbe, 0xef]) },
  ]);

  // encodeProperties は ID の昇順でソートする
  // IMMUTABLE_EXTENSIONS (0x0b) < PRIOR_GROUP_ID_GAP (0x3c) < PRIOR_OBJECT_ID_GAP (0x3e)
  const headers: Property[] = [
    { id: MOQTPropertyId.PRIOR_GROUP_ID_GAP, value: 10n },
    { id: MOQTPropertyId.PRIOR_OBJECT_ID_GAP, value: 20n },
    { id: MOQTPropertyId.IMMUTABLE_EXTENSIONS, data: innerExtensions },
  ];

  const encoded = encodeProperties(headers);
  const parsed = parseProperties(encoded);

  // Prior Group ID Gap
  assert.equal(parsed.priorGroupIdGap?.gap, 10n);

  // Prior Object ID Gap
  assert.equal(parsed.priorObjectIdGap?.gap, 20n);

  // Immutable Extensions
  assert.isDefined(parsed.immutableProperties);
  assert.equal(parsed.immutableProperties?.extensions.length, 2);
  assert.equal(parsed.immutableProperties?.extensions[0].id, 0x100n);
  assert.equal(parsed.immutableProperties?.extensions[0].value, 500n);
  assert.equal(parsed.immutableProperties?.extensions[1].id, 0x101n);
  assert.deepEqual(
    parsed.immutableProperties?.extensions[1].data,
    new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
  );

  // Unknown Extensions は空
  assert.isUndefined(parsed.unknownProperties);
});
