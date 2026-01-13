/**
 * MOQT Fetch Messages Property-Based Tests
 * draft-ietf-moq-transport-16 Section 9.16-9.18
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
import type { ExtensionHeader } from "../extensions";

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

/**
 * Track Extensions arbitrary
 *
 * draft-ietf-moq-transport-16:
 * FETCH_OK に Track Extensions が追加された。
 * https://github.com/moq-wg/moq-transport/pull/1374
 */
const evenExtensionArb = fc
  .record({
    id: fc.bigInt({ min: 0n, max: 100n }).map((n) => n * 2n),
    value: fc.bigInt({ min: 0n, max: 1000000n }),
  })
  .map(({ id, value }) => ({ id, value }));

const oddExtensionArb = fc
  .record({
    id: fc.bigInt({ min: 0n, max: 100n }).map((n) => n * 2n + 1n),
    data: fc.uint8Array({ minLength: 0, maxLength: 20 }),
  })
  .map(({ id, data }) => ({ id, data }));

const extensionHeaderArb: fc.Arbitrary<ExtensionHeader> = fc.oneof(
  evenExtensionArb,
  oddExtensionArb,
);

const trackExtensionsArb = fc.array(extensionHeaderArb, { minLength: 0, maxLength: 3 });

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

/**
 * draft-ietf-moq-transport-16:
 * FETCH_OK に Track Extensions が追加された。
 * https://github.com/moq-wg/moq-transport/pull/1374
 */
test("FetchOk のエンコード・デコードがラウンドトリップする", () => {
  fc.assert(
    fc.property(
      fc.bigInt({ min: 0n, max: 1000000n }),
      fc.boolean(),
      locationArb,
      parametersArb,
      trackExtensionsArb,
      (requestId, endOfTrack, endLocation, parameters, trackExtensions) => {
        const original: FetchOk = {
          type: MessageType.FETCH_OK,
          requestId,
          endOfTrack,
          endLocation,
          parameters,
          trackExtensions,
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
        // Track Extensions はソートされるため、ソート後の値を比較
        const sortedOriginal = [...trackExtensions].sort((a, b) =>
          a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
        );
        assert.equal(decoded.trackExtensions.length, trackExtensions.length);
        for (let i = 0; i < sortedOriginal.length; i++) {
          assert.equal(decoded.trackExtensions[i].id, sortedOriginal[i].id);
          if (sortedOriginal[i].value !== undefined) {
            assert.equal(decoded.trackExtensions[i].value, sortedOriginal[i].value);
          }
          if (sortedOriginal[i].data !== undefined) {
            assert.deepEqual(decoded.trackExtensions[i].data, sortedOriginal[i].data);
          }
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
