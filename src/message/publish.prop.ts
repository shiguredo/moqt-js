/**
 * MOQT Publish Messages Property-Based Tests
 * draft-ietf-moq-transport-16 Section 9.13-9.15
 */

import { test, assert } from "vitest";
import * as fc from "fast-check";
import {
  encodePublishPayload,
  decodePublishPayload,
  encodePublishOkPayload,
  decodePublishOkPayload,
  encodePublishDonePayload,
  decodePublishDonePayload,
} from "./publish";
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
 * PUBLISH, SUBSCRIBE_OK, FETCH_OK に Track Extensions が追加された。
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

const namespaceStringsArb = fc.array(fc.string({ minLength: 1, maxLength: 20 }), {
  minLength: 1,
  maxLength: 5,
});

const trackNameArb = fc
  .string({ minLength: 1, maxLength: 50 })
  .map((s) => new TextEncoder().encode(s));

/**
 * draft-ietf-moq-transport-16:
 * PUBLISH に Track Extensions が追加された。
 * https://github.com/moq-wg/moq-transport/pull/1374
 */
test("Publish のエンコード・デコードがラウンドトリップする", () => {
  fc.assert(
    fc.property(
      fc.bigInt({ min: 0n, max: 1000000n }),
      namespaceStringsArb,
      trackNameArb,
      fc.bigInt({ min: 0n, max: 1000000n }),
      parametersArb,
      trackExtensionsArb,
      (requestId, namespaceParts, trackName, trackAlias, parameters, trackExtensions) => {
        const original = {
          type: MessageType.PUBLISH as typeof MessageType.PUBLISH,
          requestId,
          trackNamespace: createTrackNamespace(namespaceParts),
          trackName,
          trackAlias,
          parameters,
          trackExtensions,
        };

        const encoded = encodePublishPayload(original);
        const decoded = decodePublishPayload(encoded);

        assert.equal(decoded.type, MessageType.PUBLISH);
        assert.equal(decoded.requestId, requestId);
        assert.deepEqual(trackNamespaceToStrings(decoded.trackNamespace), namespaceParts);
        assert.deepEqual(decoded.trackName, trackName);
        assert.equal(decoded.trackAlias, trackAlias);
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

test("PublishOk のエンコード・デコードがラウンドトリップする", () => {
  fc.assert(
    fc.property(fc.bigInt({ min: 0n, max: 1000000n }), parametersArb, (requestId, parameters) => {
      const original = {
        type: MessageType.PUBLISH_OK as typeof MessageType.PUBLISH_OK,
        requestId,
        parameters,
      };

      const encoded = encodePublishOkPayload(original);
      const decoded = decodePublishOkPayload(encoded);

      assert.equal(decoded.type, MessageType.PUBLISH_OK);
      assert.equal(decoded.requestId, requestId);
      assert.equal(decoded.parameters.length, parameters.length);
      for (let i = 0; i < parameters.length; i++) {
        assert.equal(decoded.parameters[i].type, parameters[i].type);
        assert.deepEqual(decoded.parameters[i].value, parameters[i].value);
      }
    }),
  );
});

test("PublishDone のエンコード・デコードがラウンドトリップする", () => {
  fc.assert(
    fc.property(
      fc.bigInt({ min: 0n, max: 1000000n }),
      fc.bigInt({ min: 0n, max: 100n }),
      fc.bigInt({ min: 0n, max: 1000000n }),
      fc.string({ minLength: 0, maxLength: 100 }),
      (requestId, statusCode, streamCount, reasonPhrase) => {
        const original = {
          type: MessageType.PUBLISH_DONE as typeof MessageType.PUBLISH_DONE,
          requestId,
          statusCode,
          streamCount,
          reasonPhrase,
        };

        const encoded = encodePublishDonePayload(original);
        const decoded = decodePublishDonePayload(encoded);

        assert.equal(decoded.type, MessageType.PUBLISH_DONE);
        assert.equal(decoded.requestId, requestId);
        assert.equal(decoded.statusCode, statusCode);
        assert.equal(decoded.streamCount, streamCount);
        assert.equal(decoded.reasonPhrase, reasonPhrase);
      },
    ),
  );
});
