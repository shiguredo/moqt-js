/**
 * MOQT Fetch Messages Property-Based Tests
 * draft-ietf-moq-transport-15 Section 9.16-9.18
 */

import { test, assert } from "vitest";
import * as fc from "fast-check";
import {
  type Fetch,
  type FetchCancel,
  type FetchOk,
  FetchType,
  decodeFetchCancelPayload,
  decodeFetchOkPayload,
  decodeFetchPayload,
  encodeFetchCancelPayload,
  encodeFetchOkPayload,
  encodeFetchPayload,
} from "./fetch";
import { createTrackNamespace, trackNamespaceToStrings, type Parameter } from "./parameter";
import { MessageType } from "./types";
import { encodeVarint } from "../varint";

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

const parameterArb: fc.Arbitrary<Parameter> = fc.oneof(evenParameterArb, oddParameterArb);

const parametersArb = fc.array(parameterArb, { minLength: 0, maxLength: 3 });

const namespaceArb = fc
  .array(fc.string({ minLength: 1, maxLength: 20 }), { minLength: 1, maxLength: 5 })
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
      namespaceArb,
      trackNameArb,
      locationArb,
      locationArb,
      parametersArb,
      (requestId, trackNamespace, trackName, startLocation, endLocation, parameters) => {
        const original: Fetch = {
          type: MessageType.FETCH,
          requestId,
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
      fc.constantFrom(FetchType.RELATIVE_JOINING, FetchType.ABSOLUTE_JOINING),
      fc.bigInt({ min: 0n, max: 1000000n }),
      fc.bigInt({ min: 0n, max: 1000000n }),
      parametersArb,
      (requestId, fetchType, joiningRequestId, joiningStart, parameters) => {
        const original: Fetch = {
          type: MessageType.FETCH,
          requestId,
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

test("FetchOk のエンコード・デコードがラウンドトリップする", () => {
  fc.assert(
    fc.property(
      fc.bigInt({ min: 0n, max: 1000000n }),
      fc.boolean(),
      locationArb,
      parametersArb,
      (requestId, endOfTrack, endLocation, parameters) => {
        const original: FetchOk = {
          type: MessageType.FETCH_OK,
          requestId,
          endOfTrack,
          endLocation,
          parameters,
        };

        const encoded = encodeFetchOkPayload(original);
        const decoded = decodeFetchOkPayload(encoded);

        assert.equal(decoded.type, MessageType.FETCH_OK);
        assert.equal(decoded.requestId, requestId);
        assert.equal(decoded.endOfTrack, endOfTrack);
        assert.equal(decoded.endLocation.group, endLocation.group);
        assert.equal(decoded.endLocation.object, endLocation.object);
        assert.equal(decoded.parameters.length, parameters.length);
        for (let i = 0; i < parameters.length; i++) {
          assert.equal(decoded.parameters[i].type, parameters[i].type);
          assert.deepEqual(decoded.parameters[i].value, parameters[i].value);
        }
      },
    ),
  );
});

test("FetchCancel のエンコード・デコードがラウンドトリップする", () => {
  fc.assert(
    fc.property(fc.bigInt({ min: 0n, max: 1000000n }), (requestId) => {
      const original: FetchCancel = {
        type: MessageType.FETCH_CANCEL,
        requestId,
      };

      const encoded = encodeFetchCancelPayload(original);
      const decoded = decodeFetchCancelPayload(encoded);

      assert.equal(decoded.type, MessageType.FETCH_CANCEL);
      assert.equal(decoded.requestId, requestId);
    }),
  );
});
