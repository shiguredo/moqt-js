/**
 * MOQT Fetch Messages Property-Based Tests
 * draft-ietf-moq-transport-17 Section 9.14-9.15
 */

import { test, assert } from "vite-plus/test";
import * as fc from "fast-check";
import { type Fetch, FetchType, decodeFetchPayload, encodeFetchPayload } from "./fetch";
import { createTrackNamespace, trackNamespaceToStrings, type Parameter } from "./parameter";
import { MessageType } from "./types";
import { encodeVarint } from "../varint";

/**
 * Message Parameter の arbitrary
 *
 * draft-ietf-moq-transport-17 Section 9.3:
 * 各パラメータ型が独自の Value エンコーディングを定義する。
 */
const varintParameterArb = fc
  .record({
    type: fc.constantFrom(0x02, 0x04, 0x08, 0x32),
    varintValue: fc.bigInt({ min: 0n, max: 1000000n }),
  })
  .map(({ type, varintValue }) => ({ type, value: encodeVarint(varintValue) }));

const uint8ParameterArb = fc
  .record({
    type: fc.constantFrom(0x10, 0x20, 0x22),
    byteValue: fc.integer({ min: 0, max: 255 }),
  })
  .map(({ type, byteValue }) => ({ type, value: new Uint8Array([byteValue]) }));

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
    type: fc.constantFrom(0x03, 0x21),
    value: fc.uint8Array({ minLength: 0, maxLength: 20 }),
  })
  .map(({ type, value }) => ({ type, value }));

const messageParameterArb: fc.Arbitrary<Parameter> = fc.oneof(
  varintParameterArb,
  uint8ParameterArb,
  locationParameterArb,
  lengthPrefixedParameterArb,
);

// delta encoding では type は昇順かつ一意である必要がある
const parametersArb = fc
  .array(messageParameterArb, { minLength: 0, maxLength: 3 })
  .map((params) => {
    const sorted = [...params].sort((a, b) => a.type - b.type);
    return sorted.filter((param, index) => index === 0 || param.type !== sorted[index - 1].type);
  });

/**
 * draft-ietf-moq-transport-17 Section 2.3:
 * ゼロ要素 (空) のネームスペースを許可する。
 * https://github.com/moq-wg/moq-transport/pull/1472
 */
const namespaceArb = fc
  .array(fc.string({ minLength: 1, maxLength: 20 }), { minLength: 0, maxLength: 5 })
  .map((parts) => createTrackNamespace(parts));

const trackNameArb = fc
  .string({ minLength: 1, maxLength: 50 })
  .map((s) => new TextEncoder().encode(s));

const locationArb = fc.record({
  group: fc.bigInt({ min: 0n, max: 1000000n }),
  object: fc.bigInt({ min: 0n, max: 1000000n }),
});

test("Fetch (Standalone) のエンコード・デコードがラウンドトリップする", () => {
  fc.assert(
    fc.property(
      fc.bigInt({ min: 0n, max: 1000000n }),
      fc.bigInt({ min: 0n, max: 1000000n }),
      namespaceArb,
      trackNameArb,
      locationArb,
      locationArb,
      parametersArb,
      (
        requestId,
        requiredRequestIdDelta,
        trackNamespace,
        trackName,
        startLocation,
        endLocation,
        parameters,
      ) => {
        const original: Fetch = {
          type: MessageType.FETCH,
          requestId,
          requiredRequestIdDelta,
          fetchType: FetchType.STANDALONE,
          standalone: {
            trackNamespace,
            trackName,
            startLocation,
            endLocation,
          },
          parameters,
        };

        const encoded = encodeFetchPayload(original);
        const decoded = decodeFetchPayload(encoded);

        assert.equal(decoded.type, MessageType.FETCH);
        assert.equal(decoded.requestId, requestId);
        assert.equal(decoded.requiredRequestIdDelta, requiredRequestIdDelta);
        assert.equal(decoded.fetchType, FetchType.STANDALONE);
        assert.isDefined(decoded.standalone);
        assert.deepEqual(
          trackNamespaceToStrings(decoded.standalone!.trackNamespace),
          trackNamespaceToStrings(trackNamespace),
        );
        assert.deepEqual(decoded.standalone!.trackName, trackName);
        assert.equal(decoded.standalone!.startLocation.group, startLocation.group);
        assert.equal(decoded.standalone!.startLocation.object, startLocation.object);
        assert.equal(decoded.standalone!.endLocation.group, endLocation.group);
        assert.equal(decoded.standalone!.endLocation.object, endLocation.object);
        assert.equal(decoded.parameters.length, parameters.length);
        for (let i = 0; i < parameters.length; i++) {
          assert.equal(decoded.parameters[i].type, parameters[i].type);
          assert.deepEqual(decoded.parameters[i].value, parameters[i].value);
        }
      },
    ),
  );
});

test("Fetch (Joining) のエンコード・デコードがラウンドトリップする", () => {
  fc.assert(
    fc.property(
      fc.bigInt({ min: 0n, max: 1000000n }),
      fc.bigInt({ min: 0n, max: 1000000n }),
      fc.constantFrom(FetchType.RELATIVE_JOINING, FetchType.ABSOLUTE_JOINING),
      fc.bigInt({ min: 0n, max: 1000000n }),
      fc.bigInt({ min: 0n, max: 1000000n }),
      parametersArb,
      (
        requestId,
        requiredRequestIdDelta,
        fetchType,
        joiningRequestId,
        joiningStart,
        parameters,
      ) => {
        const original: Fetch = {
          type: MessageType.FETCH,
          requestId,
          requiredRequestIdDelta,
          fetchType,
          joining: {
            joiningRequestId,
            joiningStart,
          },
          parameters,
        };

        const encoded = encodeFetchPayload(original);
        const decoded = decodeFetchPayload(encoded);

        assert.equal(decoded.type, MessageType.FETCH);
        assert.equal(decoded.requestId, requestId);
        assert.equal(decoded.requiredRequestIdDelta, requiredRequestIdDelta);
        assert.equal(decoded.fetchType, fetchType);
        assert.isDefined(decoded.joining);
        assert.equal(decoded.joining!.joiningRequestId, joiningRequestId);
        assert.equal(decoded.joining!.joiningStart, joiningStart);
        assert.equal(decoded.parameters.length, parameters.length);
        for (let i = 0; i < parameters.length; i++) {
          assert.equal(decoded.parameters[i].type, parameters[i].type);
          assert.deepEqual(decoded.parameters[i].value, parameters[i].value);
        }
      },
    ),
  );
});
