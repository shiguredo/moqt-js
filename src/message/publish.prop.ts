/**
 * MOQT Publish Messages Property-Based Tests
 * draft-ietf-moq-transport-15 Section 9.9-9.11
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

const namespaceStringsArb = fc.array(fc.string({ minLength: 1, maxLength: 20 }), {
  minLength: 1,
  maxLength: 5,
});

const trackNameArb = fc
  .string({ minLength: 1, maxLength: 50 })
  .map((s) => new TextEncoder().encode(s));

test("Publish のエンコード・デコードがラウンドトリップする", () => {
  fc.assert(
    fc.property(
      fc.bigInt({ min: 0n, max: 1000000n }),
      namespaceStringsArb,
      trackNameArb,
      fc.bigInt({ min: 0n, max: 1000000n }),
      parametersArb,
      (requestId, namespaceParts, trackName, trackAlias, parameters) => {
        const original = {
          type: MessageType.PUBLISH as typeof MessageType.PUBLISH,
          requestId,
          trackNamespace: createTrackNamespace(namespaceParts),
          trackName,
          trackAlias,
          parameters,
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
