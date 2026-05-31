/**
 * MOQT Properties Unit Tests
 * draft-ietf-moq-transport-18 Section 12 (MOQT Properties)
 */

import { test, assert } from "vite-plus/test";
import {
  encodeProperty,
  encodeProperties,
  encodeImmutableProperties,
  decodeImmutableProperties,
  decodeProperties,
  parseProperties,
  supportsDynamicGroups,
  validateTrackPropertyValue,
  MOQTPropertyId,
  TrackPropertyId,
  type Property,
} from "./properties";
import { MalformedTrackError, ProtocolViolationError } from "./error";

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
 * draft-ietf-moq-transport-18:
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

test("parseProperties: Immutable Properties を正しくパース", () => {
  // Immutable Properties のみ
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
 * draft-ietf-moq-transport-18:
 * delta encoding を使用するため、複数の拡張は encodeProperties でエンコードする。
 */
test("parseProperties: Immutable Properties と他の拡張の組み合わせ", () => {
  // Immutable Properties の内部データ
  const innerExtensions = encodeProperties([{ id: 0x10n, value: 999n }]);

  // Prior Group ID Gap (0x3c) + Immutable Properties (0x0b) + Prior Object ID Gap (0x3e)
  // encodeProperties は ID の昇順でソートするため、
  // 順序は IMMUTABLE_PROPERTIES (0x0b), PRIOR_GROUP_ID_GAP (0x3c), PRIOR_OBJECT_ID_GAP (0x3e)
  const headers: Property[] = [
    { id: MOQTPropertyId.PRIOR_GROUP_ID_GAP, value: 3n },
    { id: MOQTPropertyId.IMMUTABLE_PROPERTIES, data: innerExtensions },
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

test("parseProperties: Immutable Properties が unknownProperties に含まれない", () => {
  const immutable = encodeImmutableProperties({
    extensions: [{ id: 0x02n, value: 1n }],
  });

  const parsed = parseProperties(immutable);

  // Immutable Properties は unknownProperties に含まれない
  assert.isUndefined(parsed.unknownProperties);
  assert.isDefined(parsed.immutableProperties);
});

/**
 * draft-ietf-moq-transport-18:
 * delta encoding を使用するため、複数の拡張は encodeProperties でエンコードする。
 */
test("parseProperties: 全ての MOQT Core Properties を正しくパース", () => {
  // Immutable Properties の内部データ
  const innerExtensions = encodeProperties([
    { id: 0x100n, value: 500n },
    { id: 0x101n, data: new Uint8Array([0xde, 0xad, 0xbe, 0xef]) },
  ]);

  // encodeProperties は ID の昇順でソートする
  // IMMUTABLE_PROPERTIES (0x0b) < PRIOR_GROUP_ID_GAP (0x3c) < PRIOR_OBJECT_ID_GAP (0x3e)
  const headers: Property[] = [
    { id: MOQTPropertyId.PRIOR_GROUP_ID_GAP, value: 10n },
    { id: MOQTPropertyId.PRIOR_OBJECT_ID_GAP, value: 20n },
    { id: MOQTPropertyId.IMMUTABLE_PROPERTIES, data: innerExtensions },
  ];

  const encoded = encodeProperties(headers);
  const parsed = parseProperties(encoded);

  // Prior Group ID Gap
  assert.equal(parsed.priorGroupIdGap?.gap, 10n);

  // Prior Object ID Gap
  assert.equal(parsed.priorObjectIdGap?.gap, 20n);

  // Immutable Properties
  assert.isDefined(parsed.immutableProperties);
  assert.equal(parsed.immutableProperties?.extensions.length, 2);
  assert.equal(parsed.immutableProperties?.extensions[0].id, 0x100n);
  assert.equal(parsed.immutableProperties?.extensions[0].value, 500n);
  assert.equal(parsed.immutableProperties?.extensions[1].id, 0x101n);
  assert.deepEqual(
    parsed.immutableProperties?.extensions[1].data,
    new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
  );

  // Unknown Properties は空
  assert.isUndefined(parsed.unknownProperties);
});

// draft-ietf-moq-transport-18 §12.4 / §12.5 / §12.6
// Track Property の値域が MUST レベルで検証されない不具合の修正 (#0119)
test("validateTrackPropertyValue: DEFAULT_PUBLISHER_PRIORITY は 0-255 を許容する", () => {
  validateTrackPropertyValue(TrackPropertyId.DEFAULT_PUBLISHER_PRIORITY, 0n);
  validateTrackPropertyValue(TrackPropertyId.DEFAULT_PUBLISHER_PRIORITY, 255n);
});

test("validateTrackPropertyValue: DEFAULT_PUBLISHER_PRIORITY が 256 以上で ProtocolViolationError", () => {
  assert.throws(
    () => validateTrackPropertyValue(TrackPropertyId.DEFAULT_PUBLISHER_PRIORITY, 256n),
    ProtocolViolationError,
  );
  assert.throws(
    () => validateTrackPropertyValue(TrackPropertyId.DEFAULT_PUBLISHER_PRIORITY, 1000n),
    ProtocolViolationError,
  );
});

test("validateTrackPropertyValue: DEFAULT_PUBLISHER_GROUP_ORDER は 0x1 / 0x2 のみ許容する", () => {
  validateTrackPropertyValue(TrackPropertyId.DEFAULT_PUBLISHER_GROUP_ORDER, 1n);
  validateTrackPropertyValue(TrackPropertyId.DEFAULT_PUBLISHER_GROUP_ORDER, 2n);
  assert.throws(
    () => validateTrackPropertyValue(TrackPropertyId.DEFAULT_PUBLISHER_GROUP_ORDER, 0n),
    ProtocolViolationError,
  );
  assert.throws(
    () => validateTrackPropertyValue(TrackPropertyId.DEFAULT_PUBLISHER_GROUP_ORDER, 3n),
    ProtocolViolationError,
  );
});

test("validateTrackPropertyValue: DYNAMIC_GROUPS は 0 / 1 のみ許容する", () => {
  validateTrackPropertyValue(TrackPropertyId.DYNAMIC_GROUPS, 0n);
  validateTrackPropertyValue(TrackPropertyId.DYNAMIC_GROUPS, 1n);
  assert.throws(
    () => validateTrackPropertyValue(TrackPropertyId.DYNAMIC_GROUPS, 2n),
    ProtocolViolationError,
  );
  assert.throws(
    () => validateTrackPropertyValue(TrackPropertyId.DYNAMIC_GROUPS, 99n),
    ProtocolViolationError,
  );
});

test("decodeProperties: 不正な DEFAULT_PUBLISHER_PRIORITY を含むデータで ProtocolViolationError", () => {
  // ID=0x0E (delta from 0), value=300 (varint): 300 は 256 を超えるため不正
  const data = encodeProperties([{ id: TrackPropertyId.DEFAULT_PUBLISHER_PRIORITY, value: 300n }]);
  assert.throws(() => decodeProperties(data), ProtocolViolationError);
});

test("decodeProperties: 不正な DEFAULT_PUBLISHER_GROUP_ORDER を含むデータで ProtocolViolationError", () => {
  const data = encodeProperties([{ id: TrackPropertyId.DEFAULT_PUBLISHER_GROUP_ORDER, value: 0n }]);
  assert.throws(() => decodeProperties(data), ProtocolViolationError);
});

test("decodeProperties: 不正な DYNAMIC_GROUPS を含むデータで ProtocolViolationError", () => {
  const data = encodeProperties([{ id: TrackPropertyId.DYNAMIC_GROUPS, value: 2n }]);
  assert.throws(() => decodeProperties(data), ProtocolViolationError);
});

test("parseProperties: 不正な DEFAULT_PUBLISHER_PRIORITY を含むデータで ProtocolViolationError", () => {
  const data = encodeProperties([{ id: TrackPropertyId.DEFAULT_PUBLISHER_PRIORITY, value: 256n }]);
  assert.throws(() => parseProperties(data), ProtocolViolationError);
});

test("decodeImmutableProperties: 内部に不正な Track Property を含むと ProtocolViolationError", () => {
  // Immutable Properties の内部に DYNAMIC_GROUPS=2 (不正) をネスト
  const immutable = encodeImmutableProperties({
    extensions: [{ id: TrackPropertyId.DYNAMIC_GROUPS, value: 2n }],
  });
  assert.throws(() => decodeImmutableProperties(immutable), ProtocolViolationError);
});

// draft-ietf-moq-transport-18 §12.7 / §12.8 / §12.9 (#0122)
// IMMUTABLE_PROPERTIES の再帰禁止・複数出現禁止と PRIOR_GROUP_ID_GAP / PRIOR_OBJECT_ID_GAP の
// 「Object 当たり 1 つだけ」MUST を検証する
test("decodeImmutableProperties: 内部に IMMUTABLE_PROPERTIES を含むと MalformedTrackError", () => {
  // 外側 IMMUTABLE_PROPERTIES の内部に IMMUTABLE_PROPERTIES (id=0x0B, 奇数) を入れる
  const innerImmutable = encodeImmutableProperties({ extensions: [] });
  // outer の data 部にそのまま innerImmutable を埋め込む
  const outer: Property = { id: MOQTPropertyId.IMMUTABLE_PROPERTIES, data: innerImmutable };
  const encoded = encodeProperty(outer);
  assert.throws(() => decodeImmutableProperties(encoded), MalformedTrackError);
});

test("parseProperties: Object 内に IMMUTABLE_PROPERTIES を含む IMMUTABLE_PROPERTIES があると MalformedTrackError", () => {
  // 外側 IMMUTABLE_PROPERTIES の内部に IMMUTABLE_PROPERTIES を入れる
  const innerImmutable = encodeImmutableProperties({ extensions: [] });
  const outer: Property = { id: MOQTPropertyId.IMMUTABLE_PROPERTIES, data: innerImmutable };
  const encoded = encodeProperty(outer);
  assert.throws(() => parseProperties(encoded), MalformedTrackError);
});

test("parseProperties: Object 内に IMMUTABLE_PROPERTIES が 2 回現れると MalformedTrackError", () => {
  // delta encoding で同一 ID を 2 回出す (1 回目: deltaId=0x0B, 2 回目: deltaId=0x00)
  // 各 IMMUTABLE_PROPERTIES は length=0 の空内容
  // [0x0b, 0x00, 0x00, 0x00] = (deltaId=0x0B, length=0), (deltaId=0x00, length=0)
  const encoded = new Uint8Array([0x0b, 0x00, 0x00, 0x00]);
  assert.throws(() => parseProperties(encoded), MalformedTrackError);
});

test("parseProperties: Object 内に PRIOR_GROUP_ID_GAP が 2 回現れると MalformedTrackError", () => {
  // [0x3c, 0x01, 0x00, 0x02] = (deltaId=0x3c, value=1), (deltaId=0x00, value=2)
  const encoded = new Uint8Array([0x3c, 0x01, 0x00, 0x02]);
  assert.throws(() => parseProperties(encoded), MalformedTrackError);
});

test("parseProperties: Object 内に PRIOR_OBJECT_ID_GAP が 2 回現れると MalformedTrackError", () => {
  // [0x3e, 0x01, 0x00, 0x02] = (deltaId=0x3e, value=1), (deltaId=0x00, value=2)
  const encoded = new Uint8Array([0x3e, 0x01, 0x00, 0x02]);
  assert.throws(() => parseProperties(encoded), MalformedTrackError);
});

// draft-ietf-moq-transport-18 §10.2.13 / §12.6
test("supportsDynamicGroups: DYNAMIC_GROUPS=1 が mutable 側にあれば true", () => {
  const properties: Property[] = [{ id: TrackPropertyId.DYNAMIC_GROUPS, value: 1n }];
  assert.equal(supportsDynamicGroups(properties), true);
});

test("supportsDynamicGroups: DYNAMIC_GROUPS=0 が mutable 側にあれば false", () => {
  const properties: Property[] = [{ id: TrackPropertyId.DYNAMIC_GROUPS, value: 0n }];
  assert.equal(supportsDynamicGroups(properties), false);
});

test("supportsDynamicGroups: DYNAMIC_GROUPS が存在しなければ false", () => {
  const properties: Property[] = [{ id: TrackPropertyId.DEFAULT_PUBLISHER_PRIORITY, value: 128n }];
  assert.equal(supportsDynamicGroups(properties), false);
});

test("supportsDynamicGroups: Immutable Properties 内 DYNAMIC_GROUPS=1 で true", () => {
  // Immutable Properties に DYNAMIC_GROUPS=1 を 1 件入れてエンコードする。
  // encodeImmutableProperties は ID + length + body を返すため、ID 部を除いた
  // body 部のみが Property.data として decode 側に渡される想定。
  // supportsDynamicGroups は decodeImmutableProperties に Property.data をそのまま渡す。
  const encoded = encodeImmutableProperties({
    extensions: [{ id: TrackPropertyId.DYNAMIC_GROUPS, value: 1n }],
  });
  const properties: Property[] = [{ id: MOQTPropertyId.IMMUTABLE_PROPERTIES, data: encoded }];
  assert.equal(supportsDynamicGroups(properties), true);
});

test("supportsDynamicGroups: Immutable Properties 内 DYNAMIC_GROUPS=0 で false", () => {
  const encoded = encodeImmutableProperties({
    extensions: [{ id: TrackPropertyId.DYNAMIC_GROUPS, value: 0n }],
  });
  const properties: Property[] = [{ id: MOQTPropertyId.IMMUTABLE_PROPERTIES, data: encoded }];
  assert.equal(supportsDynamicGroups(properties), false);
});

test("supportsDynamicGroups: mutable=0 / Immutable=1 混在で true", () => {
  const encoded = encodeImmutableProperties({
    extensions: [{ id: TrackPropertyId.DYNAMIC_GROUPS, value: 1n }],
  });
  const properties: Property[] = [
    { id: TrackPropertyId.DYNAMIC_GROUPS, value: 0n },
    { id: MOQTPropertyId.IMMUTABLE_PROPERTIES, data: encoded },
  ];
  assert.equal(supportsDynamicGroups(properties), true);
});
