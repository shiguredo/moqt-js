/**
 * MOQT Parameter Property-Based Tests
 * draft-ietf-moq-transport-18 Section 10.2
 */

import { test, assert } from "vite-plus/test";
import * as fc from "fast-check";
import {
  encodeParameter,
  decodeParameter,
  encodeTrackNamespace,
  decodeTrackNamespace,
  createTrackNamespace,
  trackNamespaceToStrings,
  encodeLocation,
  decodeLocation,
  encodeParameters,
  decodeParameters,
  encodeLocationFilter,
  decodeLocationFilter,
  encodeLocationFilterParameter,
  decodeLocationFilterParameter,
  getParameterVarintValue,
  type LocationFilter,
} from "./parameter";
import { encodeVarint } from "../varint";

test("偶数タイプの Parameter のエンコード・デコードがラウンドトリップする", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 0, max: 100 }).map((n) => n * 2),
      fc.bigInt({ min: 0n, max: 1000000n }),
      (type, varintValue) => {
        const value = encodeVarint(varintValue);
        const param = { type, value };
        const encoded = encodeParameter(param);
        const [decoded, consumed] = decodeParameter(encoded);

        assert.equal(decoded.type, type);
        assert.equal(getParameterVarintValue(decoded), varintValue);
        assert.equal(consumed, encoded.length);
      },
    ),
  );
});

test("奇数タイプの Parameter のエンコード・デコードがラウンドトリップする", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 0, max: 100 }).map((n) => n * 2 + 1),
      fc.uint8Array({ minLength: 0, maxLength: 100 }),
      (type, value) => {
        const param = { type, value };
        const encoded = encodeParameter(param);
        const [decoded, consumed] = decodeParameter(encoded);

        assert.equal(decoded.type, type);
        assert.deepEqual(decoded.value, value);
        assert.equal(consumed, encoded.length);
      },
    ),
  );
});

test("TrackNamespace のエンコード・デコードがラウンドトリップする", () => {
  // draft-ietf-moq-transport-18 §2.3:
  // "Each Track Namespace Field Value MUST contain at least one byte."
  // 各フィールドは 1 バイト以上必要なため minLength: 1 とする
  fc.assert(
    fc.property(
      fc.array(fc.string({ minLength: 1, maxLength: 30 }), { minLength: 0, maxLength: 10 }),
      (parts) => {
        const ns = createTrackNamespace(parts);
        const encoded = encodeTrackNamespace(ns);
        const [decoded, consumed] = decodeTrackNamespace(encoded);
        const result = trackNamespaceToStrings(decoded);

        assert.deepEqual(result, parts);
        assert.equal(consumed, encoded.length);
      },
    ),
  );
});

test("Location のエンコード・デコードがラウンドトリップする", () => {
  fc.assert(
    fc.property(
      fc.bigInt({ min: 0n, max: 10000000n }),
      fc.bigInt({ min: 0n, max: 10000000n }),
      (group, object) => {
        const location = { group, object };
        const encoded = encodeLocation(location);
        const [decoded, consumed] = decodeLocation(encoded);

        assert.equal(decoded.group, group);
        assert.equal(decoded.object, object);
        assert.equal(consumed, encoded.length);
      },
    ),
  );
});

/**
 * Message Parameter の arbitrary
 *
 * draft-ietf-moq-transport-18 Section 10.2:
 * 各パラメータ型が独自の Value エンコーディングを定義する。
 * - varint: 0x02, 0x04, 0x06, 0x08, 0x32
 * - uint8: 0x10, 0x20, 0x22
 * - location: 0x09
 * - length-prefixed: 0x03, 0x21, 0x34
 */
const varintParameterArb = fc
  .record({
    type: fc.constantFrom(0x02, 0x04, 0x06, 0x08, 0x32),
    varintValue: fc.bigInt({ min: 0n, max: 1000000n }),
  })
  .map(({ type, varintValue }) => ({ type, value: encodeVarint(varintValue) }));

// draft-ietf-moq-transport-18 §10.2.8 / §10.2.12: 値域制約に従う arbitrary
//   - FORWARD (0x10): 0 / 1
//   - SUBSCRIBER_PRIORITY (0x20): 0-255
//   - GROUP_ORDER (0x22): 0x1 / 0x2
const uint8ParameterArb = fc.oneof(
  fc
    .record({ type: fc.constant(0x10), byteValue: fc.constantFrom(0, 1) })
    .map(({ type, byteValue }) => ({ type, value: new Uint8Array([byteValue]) })),
  fc
    .record({ type: fc.constant(0x20), byteValue: fc.integer({ min: 0, max: 255 }) })
    .map(({ type, byteValue }) => ({ type, value: new Uint8Array([byteValue]) })),
  fc
    .record({ type: fc.constant(0x22), byteValue: fc.constantFrom(1, 2) })
    .map(({ type, byteValue }) => ({ type, value: new Uint8Array([byteValue]) })),
);

const locationParameterArb = fc
  .record({
    group: fc.bigInt({ min: 0n, max: 1000000n }),
    object: fc.bigInt({ min: 0n, max: 1000000n }),
  })
  .map(({ group, object }) => {
    const groupBytes = encodeVarint(group);
    const objectBytes = encodeVarint(object);
    const value = new Uint8Array(groupBytes.length + objectBytes.length);
    value.set(groupBytes, 0);
    value.set(objectBytes, groupBytes.length);
    return { type: 0x09, value };
  });

const lengthPrefixedParameterArb = fc
  .record({
    type: fc.constantFrom(0x03, 0x21, 0x34),
    value: fc.uint8Array({ minLength: 0, maxLength: 20 }),
  })
  .map(({ type, value }) => ({ type, value }));

const messageParameterArb = fc.oneof(
  varintParameterArb,
  uint8ParameterArb,
  locationParameterArb,
  lengthPrefixedParameterArb,
);

/**
 * Message Parameters リストの arbitrary
 *
 * draft-ietf-moq-transport-18 Section 10.2:
 * パラメータは Type の昇順でソートされ、各 Type は一意である必要がある。
 */
const parametersArb = fc
  .array(messageParameterArb, { minLength: 0, maxLength: 3 })
  .map((params) => {
    const sorted = [...params].sort((a, b) => a.type - b.type);
    return sorted.filter((param, index) => index === 0 || param.type !== sorted[index - 1].type);
  });

/**
 * Parameters リストのエンコード・デコードがラウンドトリップする
 *
 * draft-ietf-moq-transport-18 Section 10.2:
 * delta encoding を使用するため、type は昇順である必要がある。
 * テストでは生成されたパラメータを type でソートしてから使用する。
 */
test("Parameters リストのエンコード・デコードがラウンドトリップする", () => {
  fc.assert(
    fc.property(parametersArb, (params) => {
      const encoded = encodeParameters(params);
      const [decoded, consumed] = decodeParameters(encoded);

      assert.equal(decoded.length, params.length);
      for (let i = 0; i < params.length; i++) {
        assert.equal(decoded[i].type, params[i].type);
        assert.deepEqual(decoded[i].value, params[i].value);
      }
      assert.equal(consumed, encoded.length);
    }),
  );
});

const locationFilterArb: fc.Arbitrary<LocationFilter> = fc.oneof(
  fc.constant({ type: "NextGroupStart" as const }),
  fc.constant({ type: "LargestObject" as const }),
  fc.record({
    type: fc.constant("AbsoluteStart" as const),
    startLocation: fc.record({
      group: fc.bigInt({ min: 0n, max: 1000000n }),
      object: fc.bigInt({ min: 0n, max: 1000000n }),
    }),
  }),
  fc.record({
    type: fc.constant("AbsoluteRange" as const),
    startLocation: fc.record({
      group: fc.bigInt({ min: 0n, max: 1000000n }),
      object: fc.bigInt({ min: 0n, max: 1000000n }),
    }),
    endGroupDelta: fc.bigInt({ min: 0n, max: 1000000n }),
  }),
);

test("LocationFilter のエンコード・デコードがラウンドトリップする", () => {
  fc.assert(
    fc.property(locationFilterArb, (filter) => {
      const encoded = encodeLocationFilter(filter);
      const [decoded, consumed] = decodeLocationFilter(encoded);

      assert.equal(decoded.type, filter.type);
      if (filter.type === "AbsoluteStart" && decoded.type === "AbsoluteStart") {
        assert.equal(decoded.startLocation.group, filter.startLocation.group);
        assert.equal(decoded.startLocation.object, filter.startLocation.object);
      }
      if (filter.type === "AbsoluteRange" && decoded.type === "AbsoluteRange") {
        assert.equal(decoded.startLocation.group, filter.startLocation.group);
        assert.equal(decoded.startLocation.object, filter.startLocation.object);
        assert.equal(decoded.endGroupDelta, filter.endGroupDelta);
      }
      assert.equal(consumed, encoded.length);
    }),
  );
});

test("LocationFilter パラメータのエンコード・デコードがラウンドトリップする", () => {
  fc.assert(
    fc.property(locationFilterArb, (filter) => {
      const param = encodeLocationFilterParameter(filter);
      assert.equal(param.type, 0x21);

      const decoded = decodeLocationFilterParameter(param);
      assert.equal(decoded.type, filter.type);
      if (filter.type === "AbsoluteStart" && decoded.type === "AbsoluteStart") {
        assert.equal(decoded.startLocation.group, filter.startLocation.group);
        assert.equal(decoded.startLocation.object, filter.startLocation.object);
      }
      if (filter.type === "AbsoluteRange" && decoded.type === "AbsoluteRange") {
        assert.equal(decoded.startLocation.group, filter.startLocation.group);
        assert.equal(decoded.startLocation.object, filter.startLocation.object);
        assert.equal(decoded.endGroupDelta, filter.endGroupDelta);
      }
    }),
  );
});
