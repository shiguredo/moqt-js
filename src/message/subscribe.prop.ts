/**
 * MOQT Subscribe Messages Property-Based Tests
 * draft-ietf-moq-transport-15 Section 9.12-9.15
 */

import { test, assert } from "vitest";
import * as fc from "fast-check";
import {
  encodeSubscribePayload,
  decodeSubscribePayload,
  encodeSubscribeOkPayload,
  decodeSubscribeOkPayload,
  encodeSubscribeUpdatePayload,
  decodeSubscribeUpdatePayload,
  encodeUnsubscribePayload,
  decodeUnsubscribePayload,
} from "./subscribe";
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

test("Subscribe のエンコード・デコードがラウンドトリップする", () => {
  fc.assert(
    fc.property(
      fc.bigInt({ min: 0n, max: 1000000n }),
      namespaceStringsArb,
      trackNameArb,
      parametersArb,
      (requestId, namespaceParts, trackName, parameters) => {
        const original = {
          type: MessageType.SUBSCRIBE as typeof MessageType.SUBSCRIBE,
          requestId,
          trackNamespace: createTrackNamespace(namespaceParts),
          trackName,
          parameters,
        };

        const encoded = encodeSubscribePayload(original);
        const decoded = decodeSubscribePayload(encoded);

        assert.equal(decoded.type, MessageType.SUBSCRIBE);
        assert.equal(decoded.requestId, requestId);
        assert.deepEqual(trackNamespaceToStrings(decoded.trackNamespace), namespaceParts);
        assert.deepEqual(decoded.trackName, trackName);
        assert.equal(decoded.parameters.length, parameters.length);
        for (let i = 0; i < parameters.length; i++) {
          assert.equal(decoded.parameters[i].type, parameters[i].type);
          assert.deepEqual(decoded.parameters[i].value, parameters[i].value);
        }
      },
    ),
  );
});

test("SubscribeOk のエンコード・デコードがラウンドトリップする", () => {
  fc.assert(
    fc.property(
      fc.bigInt({ min: 0n, max: 1000000n }),
      fc.bigInt({ min: 0n, max: 1000000n }),
      parametersArb,
      (requestId, trackAlias, parameters) => {
        const original = {
          type: MessageType.SUBSCRIBE_OK as typeof MessageType.SUBSCRIBE_OK,
          requestId,
          trackAlias,
          parameters,
        };

        const encoded = encodeSubscribeOkPayload(original);
        const decoded = decodeSubscribeOkPayload(encoded);

        assert.equal(decoded.type, MessageType.SUBSCRIBE_OK);
        assert.equal(decoded.requestId, requestId);
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

test("SubscribeUpdate のエンコード・デコードがラウンドトリップする", () => {
  fc.assert(
    fc.property(
      fc.bigInt({ min: 0n, max: 1000000n }),
      fc.bigInt({ min: 0n, max: 1000000n }),
      parametersArb,
      (requestId, subscriptionRequestId, parameters) => {
        const original = {
          type: MessageType.SUBSCRIBE_UPDATE as typeof MessageType.SUBSCRIBE_UPDATE,
          requestId,
          subscriptionRequestId,
          parameters,
        };

        const encoded = encodeSubscribeUpdatePayload(original);
        const decoded = decodeSubscribeUpdatePayload(encoded);

        assert.equal(decoded.type, MessageType.SUBSCRIBE_UPDATE);
        assert.equal(decoded.requestId, requestId);
        assert.equal(decoded.subscriptionRequestId, subscriptionRequestId);
        assert.equal(decoded.parameters.length, parameters.length);
        for (let i = 0; i < parameters.length; i++) {
          assert.equal(decoded.parameters[i].type, parameters[i].type);
          assert.deepEqual(decoded.parameters[i].value, parameters[i].value);
        }
      },
    ),
  );
});

test("Unsubscribe のエンコード・デコードがラウンドトリップする", () => {
  fc.assert(
    fc.property(fc.bigInt({ min: 0n, max: 1000000n }), (requestId) => {
      const original = {
        type: MessageType.UNSUBSCRIBE as typeof MessageType.UNSUBSCRIBE,
        requestId,
      };

      const encoded = encodeUnsubscribePayload(original);
      const decoded = decodeUnsubscribePayload(encoded);

      assert.equal(decoded.type, MessageType.UNSUBSCRIBE);
      assert.equal(decoded.requestId, requestId);
    }),
  );
});
