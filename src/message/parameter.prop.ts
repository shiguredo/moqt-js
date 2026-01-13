/**
 * MOQT Parameter Property-Based Tests
 * draft-ietf-moq-transport-16 Section 9.2
 */

import { test, assert } from "vitest";
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
  encodeSubscriptionFilter,
  decodeSubscriptionFilter,
  encodeSubscriptionFilterParameter,
  decodeSubscriptionFilterParameter,
  getParameterVarintValue,
  type SubscriptionFilter,
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
  fc.assert(
    fc.property(
      fc.array(fc.string({ minLength: 0, maxLength: 30 }), { minLength: 0, maxLength: 10 }),
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

const evenParameterArb = fc
  .record({
    type: fc.integer({ min: 0, max: 100 }).map((n) => n * 2),
    varintValue: fc.bigInt({ min: 0n, max: 1000000n }),
  })
  .map(({ type, varintValue }) => ({ type, value: encodeVarint(varintValue) }));

const oddParameterArb = fc.record({
  type: fc.integer({ min: 0, max: 100 }).map((n) => n * 2 + 1),
  value: fc.uint8Array({ minLength: 0, maxLength: 20 }),
});

const parameterArb = fc.oneof(evenParameterArb, oddParameterArb);

/**
 * Parameters リストのエンコード・デコードがラウンドトリップする
 *
 * draft-ietf-moq-transport-16:
 * delta encoding を使用するため、type は昇順である必要がある。
 * テストでは生成されたパラメータを type でソートしてから使用する。
 */
test("Parameters リストのエンコード・デコードがラウンドトリップする", () => {
  fc.assert(
    fc.property(fc.array(parameterArb, { minLength: 0, maxLength: 5 }), (params) => {
      // delta encoding では type は昇順である必要があるため、ソートする
      const sortedParams = [...params].sort((a, b) => a.type - b.type);

      // 重複する type を除去する（delta encoding では各 type は一意である必要がある）
      const uniqueParams = sortedParams.filter(
        (param, index) => index === 0 || param.type !== sortedParams[index - 1].type,
      );

      const encoded = encodeParameters(uniqueParams);
      const [decoded, consumed] = decodeParameters(encoded);

      assert.equal(decoded.length, uniqueParams.length);
      for (let i = 0; i < uniqueParams.length; i++) {
        assert.equal(decoded[i].type, uniqueParams[i].type);
        assert.deepEqual(decoded[i].value, uniqueParams[i].value);
      }
      assert.equal(consumed, encoded.length);
    }),
  );
});

const subscriptionFilterArb: fc.Arbitrary<SubscriptionFilter> = fc.oneof(
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
    endGroup: fc.bigInt({ min: 0n, max: 1000000n }),
  }),
);

test("SubscriptionFilter のエンコード・デコードがラウンドトリップする", () => {
  fc.assert(
    fc.property(subscriptionFilterArb, (filter) => {
      const encoded = encodeSubscriptionFilter(filter);
      const [decoded, consumed] = decodeSubscriptionFilter(encoded);

      assert.equal(decoded.type, filter.type);
      if (filter.type === "AbsoluteStart" && decoded.type === "AbsoluteStart") {
        assert.equal(decoded.startLocation.group, filter.startLocation.group);
        assert.equal(decoded.startLocation.object, filter.startLocation.object);
      }
      if (filter.type === "AbsoluteRange" && decoded.type === "AbsoluteRange") {
        assert.equal(decoded.startLocation.group, filter.startLocation.group);
        assert.equal(decoded.startLocation.object, filter.startLocation.object);
        assert.equal(decoded.endGroup, filter.endGroup);
      }
      assert.equal(consumed, encoded.length);
    }),
  );
});

test("SubscriptionFilter パラメータのエンコード・デコードがラウンドトリップする", () => {
  fc.assert(
    fc.property(subscriptionFilterArb, (filter) => {
      const param = encodeSubscriptionFilterParameter(filter);
      assert.equal(param.type, 0x21);

      const decoded = decodeSubscriptionFilterParameter(param);
      assert.equal(decoded.type, filter.type);
      if (filter.type === "AbsoluteStart" && decoded.type === "AbsoluteStart") {
        assert.equal(decoded.startLocation.group, filter.startLocation.group);
        assert.equal(decoded.startLocation.object, filter.startLocation.object);
      }
      if (filter.type === "AbsoluteRange" && decoded.type === "AbsoluteRange") {
        assert.equal(decoded.startLocation.group, filter.startLocation.group);
        assert.equal(decoded.startLocation.object, filter.startLocation.object);
        assert.equal(decoded.endGroup, filter.endGroup);
      }
    }),
  );
});
