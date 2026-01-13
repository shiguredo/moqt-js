/**
 * MOQT Extension Headers Unit Tests
 * draft-ietf-moq-transport-16 Section 11
 */

import { test, assert } from "vitest";
import {
  encodeExtensionHeader,
  encodeExtensionHeaders,
  encodeImmutableExtensions,
  decodeImmutableExtensions,
  parseExtensionHeaders,
  MOQTExtensionHeaderId,
  type ExtensionHeader,
} from "./extensions";

test("encodeExtensionHeader: 偶数 ID は varint value 形式でエンコード", () => {
  const header: ExtensionHeader = { id: 0x02n, value: 42n };
  const encoded = encodeExtensionHeader(header);

  // ID: 0x02 (1 byte) + value: 42 (1 byte, varint で 42 < 64 なので 1 バイト)
  assert.equal(encoded[0], 0x02);
  assert.equal(encoded[1], 42);
});

test("encodeExtensionHeader: 奇数 ID は length + bytes 形式でエンコード", () => {
  const header: ExtensionHeader = { id: 0x03n, data: new Uint8Array([0xaa, 0xbb, 0xcc]) };
  const encoded = encodeExtensionHeader(header);

  // ID: 0x03 (1 byte) + length: 3 (1 byte) + data: 3 bytes
  assert.equal(encoded[0], 0x03);
  assert.equal(encoded[1], 3);
  assert.deepEqual(encoded.subarray(2), new Uint8Array([0xaa, 0xbb, 0xcc]));
});

test("encodeExtensionHeader: 偶数 ID で value がない場合はエラー", () => {
  const header: ExtensionHeader = { id: 0x02n };
  assert.throws(() => encodeExtensionHeader(header), /requires a value/);
});

test("encodeExtensionHeader: 奇数 ID で data がない場合はエラー", () => {
  const header: ExtensionHeader = { id: 0x03n };
  assert.throws(() => encodeExtensionHeader(header), /requires data/);
});

/**
 * draft-ietf-moq-transport-16:
 * delta encoding を使用するため、ID は前の ID からの差分としてエンコードされる。
 */
test("encodeExtensionHeaders: 複数の拡張を delta encoding でエンコードして結合", () => {
  const headers: ExtensionHeader[] = [
    { id: 0x02n, value: 42n },
    { id: 0x03n, data: new Uint8Array([0xff]) },
  ];
  const encoded = encodeExtensionHeaders(headers);

  // delta encoding: delta(0x02)=0x02, value=42, delta(0x03-0x02)=0x01, length=1, data=0xff
  assert.equal(encoded.length, 5);
  assert.equal(encoded[0], 0x02);
  assert.equal(encoded[1], 42);
  assert.equal(encoded[2], 0x01);
  assert.equal(encoded[3], 1);
  assert.equal(encoded[4], 0xff);
});

test("encodeImmutableExtensions: 空の拡張リスト", () => {
  const immutable = { extensions: [] };
  const encoded = encodeImmutableExtensions(immutable);

  // ID: 0x0B (1 byte) + length: 0 (1 byte)
  assert.equal(encoded[0], 0x0b);
  assert.equal(encoded[1], 0);
  assert.equal(encoded.length, 2);
});

test("encodeImmutableExtensions: 単一の偶数 ID 拡張", () => {
  const immutable = {
    extensions: [{ id: 0x04n, value: 12345n }],
  };
  const encoded = encodeImmutableExtensions(immutable);

  // ID: 0x0B + length + (ID: 0x04 + value: 12345)
  assert.equal(encoded[0], 0x0b);
  // 内部: 0x04 (1 byte) + 12345 = 0x4039 (2 bytes) = 3 bytes
  assert.equal(encoded[1], 3);
});

test("encodeImmutableExtensions: 単一の奇数 ID 拡張", () => {
  const data = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
  const immutable = {
    extensions: [{ id: 0x05n, data }],
  };
  const encoded = encodeImmutableExtensions(immutable);

  // ID: 0x0B + length + (ID: 0x05 + length: 4 + data: 4 bytes)
  assert.equal(encoded[0], 0x0b);
  // 内部: 0x05 (1 byte) + 4 (1 byte) + data (4 bytes) = 6 bytes
  assert.equal(encoded[1], 6);
});

test("encodeImmutableExtensions: 複数の拡張", () => {
  const immutable = {
    extensions: [
      { id: 0x02n, value: 10n },
      { id: 0x03n, data: new Uint8Array([0xaa, 0xbb]) },
      { id: 0x04n, value: 20n },
    ],
  };
  const encoded = encodeImmutableExtensions(immutable);

  // ID: 0x0B + length + 内部データ
  assert.equal(encoded[0], 0x0b);
  // 内部: (0x02, 10) + (0x03, 2, 0xaa, 0xbb) + (0x04, 20)
  // = 2 + 4 + 2 = 8 bytes (varint で 10, 20 < 64 なので各 1 バイト)
  assert.equal(encoded[1], 8);
});

test("decodeImmutableExtensions: 空の拡張リスト", () => {
  const encoded = new Uint8Array([0x0b, 0x00]);
  const decoded = decodeImmutableExtensions(encoded);

  assert.deepEqual(decoded.extensions, []);
});

test("decodeImmutableExtensions: 単一の偶数 ID 拡張", () => {
  // ID: 0x0B, length: 2, (ID: 0x02, value: 42)
  const encoded = new Uint8Array([0x0b, 0x02, 0x02, 42]);
  const decoded = decodeImmutableExtensions(encoded);

  assert.equal(decoded.extensions.length, 1);
  assert.equal(decoded.extensions[0].id, 0x02n);
  assert.equal(decoded.extensions[0].value, 42n);
});

test("decodeImmutableExtensions: 単一の奇数 ID 拡張", () => {
  // ID: 0x0B, length: 5, (ID: 0x03, length: 3, data: 0xaa, 0xbb, 0xcc)
  const encoded = new Uint8Array([0x0b, 0x05, 0x03, 0x03, 0xaa, 0xbb, 0xcc]);
  const decoded = decodeImmutableExtensions(encoded);

  assert.equal(decoded.extensions.length, 1);
  assert.equal(decoded.extensions[0].id, 0x03n);
  assert.deepEqual(decoded.extensions[0].data, new Uint8Array([0xaa, 0xbb, 0xcc]));
});

test("encodeImmutableExtensions と decodeImmutableExtensions のラウンドトリップ: 空", () => {
  const original = { extensions: [] };
  const encoded = encodeImmutableExtensions(original);
  const decoded = decodeImmutableExtensions(encoded);

  assert.deepEqual(decoded.extensions, original.extensions);
});

test("encodeImmutableExtensions と decodeImmutableExtensions のラウンドトリップ: 偶数 ID", () => {
  const original = {
    extensions: [{ id: 0x02n, value: 12345n }],
  };
  const encoded = encodeImmutableExtensions(original);
  const decoded = decodeImmutableExtensions(encoded);

  assert.equal(decoded.extensions.length, 1);
  assert.equal(decoded.extensions[0].id, 0x02n);
  assert.equal(decoded.extensions[0].value, 12345n);
});

test("encodeImmutableExtensions と decodeImmutableExtensions のラウンドトリップ: 奇数 ID", () => {
  const original = {
    extensions: [{ id: 0x03n, data: new Uint8Array([0x01, 0x02, 0x03]) }],
  };
  const encoded = encodeImmutableExtensions(original);
  const decoded = decodeImmutableExtensions(encoded);

  assert.equal(decoded.extensions.length, 1);
  assert.equal(decoded.extensions[0].id, 0x03n);
  assert.deepEqual(decoded.extensions[0].data, new Uint8Array([0x01, 0x02, 0x03]));
});

test("encodeImmutableExtensions と decodeImmutableExtensions のラウンドトリップ: 複合", () => {
  const original = {
    extensions: [
      { id: 0x02n, value: 100n },
      { id: 0x03n, data: new Uint8Array([0xaa, 0xbb]) },
      { id: 0x04n, value: 200n },
    ],
  };
  const encoded = encodeImmutableExtensions(original);
  const decoded = decodeImmutableExtensions(encoded);

  assert.equal(decoded.extensions.length, 3);
  assert.equal(decoded.extensions[0].id, 0x02n);
  assert.equal(decoded.extensions[0].value, 100n);
  assert.equal(decoded.extensions[1].id, 0x03n);
  assert.deepEqual(decoded.extensions[1].data, new Uint8Array([0xaa, 0xbb]));
  assert.equal(decoded.extensions[2].id, 0x04n);
  assert.equal(decoded.extensions[2].value, 200n);
});

test("parseExtensionHeaders: Immutable Extensions を正しくパース", () => {
  // Immutable Extensions のみ
  const immutable = encodeImmutableExtensions({
    extensions: [
      { id: 0x02n, value: 42n },
      { id: 0x05n, data: new Uint8Array([0x01, 0x02]) },
    ],
  });

  const parsed = parseExtensionHeaders(immutable);

  assert.isDefined(parsed.immutableExtensions);
  assert.equal(parsed.immutableExtensions?.extensions.length, 2);
  assert.equal(parsed.immutableExtensions?.extensions[0].id, 0x02n);
  assert.equal(parsed.immutableExtensions?.extensions[0].value, 42n);
  assert.equal(parsed.immutableExtensions?.extensions[1].id, 0x05n);
  assert.deepEqual(parsed.immutableExtensions?.extensions[1].data, new Uint8Array([0x01, 0x02]));
});

/**
 * draft-ietf-moq-transport-16:
 * delta encoding を使用するため、複数の拡張は encodeExtensionHeaders でエンコードする。
 */
test("parseExtensionHeaders: Immutable Extensions と他の拡張の組み合わせ", () => {
  // Immutable Extensions の内部データ
  const innerExtensions = encodeExtensionHeaders([{ id: 0x10n, value: 999n }]);

  // Prior Group ID Gap (0x3c) + Immutable Extensions (0x0b) + Prior Object ID Gap (0x3e)
  // encodeExtensionHeaders は ID の昇順でソートするため、
  // 順序は IMMUTABLE_EXTENSIONS (0x0b), PRIOR_GROUP_ID_GAP (0x3c), PRIOR_OBJECT_ID_GAP (0x3e)
  const headers: ExtensionHeader[] = [
    { id: MOQTExtensionHeaderId.PRIOR_GROUP_ID_GAP, value: 3n },
    { id: MOQTExtensionHeaderId.IMMUTABLE_EXTENSIONS, data: innerExtensions },
    { id: MOQTExtensionHeaderId.PRIOR_OBJECT_ID_GAP, value: 5n },
  ];

  const encoded = encodeExtensionHeaders(headers);
  const parsed = parseExtensionHeaders(encoded);

  assert.equal(parsed.priorGroupIdGap?.gap, 3n);
  assert.equal(parsed.priorObjectIdGap?.gap, 5n);
  assert.isDefined(parsed.immutableExtensions);
  assert.equal(parsed.immutableExtensions?.extensions.length, 1);
  assert.equal(parsed.immutableExtensions?.extensions[0].id, 0x10n);
  assert.equal(parsed.immutableExtensions?.extensions[0].value, 999n);
});

test("parseExtensionHeaders: Immutable Extensions が unknownExtensions に含まれない", () => {
  const immutable = encodeImmutableExtensions({
    extensions: [{ id: 0x02n, value: 1n }],
  });

  const parsed = parseExtensionHeaders(immutable);

  // Immutable Extensions は unknownExtensions に含まれない
  assert.isUndefined(parsed.unknownExtensions);
  assert.isDefined(parsed.immutableExtensions);
});

/**
 * draft-ietf-moq-transport-16:
 * delta encoding を使用するため、複数の拡張は encodeExtensionHeaders でエンコードする。
 */
test("parseExtensionHeaders: 全ての MOQT Core Extensions を正しくパース", () => {
  // Immutable Extensions の内部データ
  const innerExtensions = encodeExtensionHeaders([
    { id: 0x100n, value: 500n },
    { id: 0x101n, data: new Uint8Array([0xde, 0xad, 0xbe, 0xef]) },
  ]);

  // encodeExtensionHeaders は ID の昇順でソートする
  // IMMUTABLE_EXTENSIONS (0x0b) < PRIOR_GROUP_ID_GAP (0x3c) < PRIOR_OBJECT_ID_GAP (0x3e)
  const headers: ExtensionHeader[] = [
    { id: MOQTExtensionHeaderId.PRIOR_GROUP_ID_GAP, value: 10n },
    { id: MOQTExtensionHeaderId.PRIOR_OBJECT_ID_GAP, value: 20n },
    { id: MOQTExtensionHeaderId.IMMUTABLE_EXTENSIONS, data: innerExtensions },
  ];

  const encoded = encodeExtensionHeaders(headers);
  const parsed = parseExtensionHeaders(encoded);

  // Prior Group ID Gap
  assert.equal(parsed.priorGroupIdGap?.gap, 10n);

  // Prior Object ID Gap
  assert.equal(parsed.priorObjectIdGap?.gap, 20n);

  // Immutable Extensions
  assert.isDefined(parsed.immutableExtensions);
  assert.equal(parsed.immutableExtensions?.extensions.length, 2);
  assert.equal(parsed.immutableExtensions?.extensions[0].id, 0x100n);
  assert.equal(parsed.immutableExtensions?.extensions[0].value, 500n);
  assert.equal(parsed.immutableExtensions?.extensions[1].id, 0x101n);
  assert.deepEqual(
    parsed.immutableExtensions?.extensions[1].data,
    new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
  );

  // Unknown Extensions は空
  assert.isUndefined(parsed.unknownExtensions);
});
