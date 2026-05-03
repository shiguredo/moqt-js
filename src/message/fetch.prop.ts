/**
 * MOQT Fetch Messages Property-Based Tests
 * draft-ietf-moq-transport-17 Section 9.14-9.15
 */

import { test, assert } from "vite-plus/test";
import * as fc from "fast-check";
import {
  type Fetch,
  type FetchOk,
  FetchType,
  decodeFetchOkPayload,
  decodeFetchPayload,
  encodeFetchOkPayload,
  encodeFetchPayload,
} from "./fetch";
import { createTrackNamespace, trackNamespaceToStrings, type Parameter } from "./parameter";
import { MessageType } from "./types";
import { encodeVarint } from "../varint";
import { ProtocolViolationError } from "../error";
import type { Property } from "../properties";

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
 * Track Extensions arbitrary
 *
 * draft-ietf-moq-transport-17:
 * FETCH_OK に Track Extensions が追加された。
 * https://github.com/moq-wg/moq-transport/pull/1374
 */
const evenPropertyArb = fc
  .record({
    id: fc.bigInt({ min: 0n, max: 100n }).map((n) => n * 2n),
    value: fc.bigInt({ min: 0n, max: 1000000n }),
  })
  .map(({ id, value }) => ({ id, value }));

const oddPropertyArb = fc
  .record({
    id: fc.bigInt({ min: 0n, max: 100n }).map((n) => n * 2n + 1n),
    data: fc.uint8Array({ minLength: 0, maxLength: 20 }),
  })
  .map(({ id, data }) => ({ id, data }));

const propertyArb: fc.Arbitrary<Property> = fc.oneof(evenPropertyArb, oddPropertyArb);

const trackPropertiesArb = fc.array(propertyArb, { minLength: 0, maxLength: 3 });

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

/**
 * draft-ietf-moq-transport-17 Section 9.14 (FETCH):
 * "An endpoint that receives a Fetch Type other than 0x1, 0x2 or 0x3 MUST close
 *  the session with a PROTOCOL_VIOLATION."
 * decode 段階で ProtocolViolationError が投げられることを保証する。
 */
test("Fetch Type が 0x1/0x2/0x3 以外なら decodeFetchPayload は ProtocolViolationError を throw する", () => {
  fc.assert(
    fc.property(
      fc.bigInt({ min: 0n, max: 1000000n }),
      fc.bigInt({ min: 0n, max: 1000000n }),
      // 0x0 と 0x4 以上の不正値を混ぜる (0x1/0x2/0x3 だけ除外)
      fc.bigInt({ min: 0n, max: 1024n }).filter((n) => n !== 1n && n !== 2n && n !== 3n),
      (requestId, requiredRequestIdDelta, invalidFetchType) => {
        const requestIdBytes = encodeVarint(requestId);
        const requiredRequestIdDeltaBytes = encodeVarint(requiredRequestIdDelta);
        const fetchTypeBytes = encodeVarint(invalidFetchType);
        const payload = new Uint8Array(
          requestIdBytes.length + requiredRequestIdDeltaBytes.length + fetchTypeBytes.length,
        );
        payload.set(requestIdBytes, 0);
        payload.set(requiredRequestIdDeltaBytes, requestIdBytes.length);
        payload.set(fetchTypeBytes, requestIdBytes.length + requiredRequestIdDeltaBytes.length);

        assert.throws(() => decodeFetchPayload(payload), ProtocolViolationError);
      },
    ),
  );
});

/**
 * draft-ietf-moq-transport-17:
 * FETCH_OK に Track Extensions が追加された。
 * https://github.com/moq-wg/moq-transport/pull/1374
 */
test("FetchOk のエンコード・デコードがラウンドトリップする", () => {
  fc.assert(
    fc.property(
      fc.boolean(),
      locationArb,
      parametersArb,
      trackPropertiesArb,
      (endOfTrack, endLocation, parameters, trackProperties) => {
        const original: FetchOk = {
          type: MessageType.FETCH_OK,
          endOfTrack,
          endLocation,
          parameters,
          trackProperties,
        };

        const encoded = encodeFetchOkPayload(original);
        const decoded = decodeFetchOkPayload(encoded);

        assert.equal(decoded.type, MessageType.FETCH_OK);
        assert.equal(decoded.endOfTrack, endOfTrack);
        assert.equal(decoded.endLocation.group, endLocation.group);
        assert.equal(decoded.endLocation.object, endLocation.object);
        assert.equal(decoded.parameters.length, parameters.length);
        for (let i = 0; i < parameters.length; i++) {
          assert.equal(decoded.parameters[i].type, parameters[i].type);
          assert.deepEqual(decoded.parameters[i].value, parameters[i].value);
        }
        // Track Extensions はソートされるため、ソート後の値を比較
        const sortedOriginal = [...trackProperties].sort((a, b) =>
          a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
        );
        assert.equal(decoded.trackProperties.length, trackProperties.length);
        for (let i = 0; i < sortedOriginal.length; i++) {
          assert.equal(decoded.trackProperties[i].id, sortedOriginal[i].id);
          if (sortedOriginal[i].value !== undefined) {
            assert.equal(decoded.trackProperties[i].value, sortedOriginal[i].value);
          }
          if (sortedOriginal[i].data !== undefined) {
            assert.deepEqual(decoded.trackProperties[i].data, sortedOriginal[i].data);
          }
        }
      },
    ),
  );
});
