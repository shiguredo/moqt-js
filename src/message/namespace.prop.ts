/**
 * MOQT Namespace Messages Property-Based Tests
 * draft-ietf-moq-transport-15 Section 9.20-9.24
 */

import { test, assert } from "vitest";
import * as fc from "fast-check";
import {
  type PublishNamespace,
  type PublishNamespaceCancel,
  type PublishNamespaceDone,
  type SubscribeNamespace,
  type UnsubscribeNamespace,
  decodePublishNamespaceCancelPayload,
  decodePublishNamespaceDonePayload,
  decodePublishNamespacePayload,
  decodeSubscribeNamespacePayload,
  decodeUnsubscribeNamespacePayload,
  encodePublishNamespaceCancelPayload,
  encodePublishNamespaceDonePayload,
  encodePublishNamespacePayload,
  encodeSubscribeNamespacePayload,
  encodeUnsubscribeNamespacePayload,
} from "./namespace";
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

test("PublishNamespace のエンコード・デコードがラウンドトリップする", () => {
  fc.assert(
    fc.property(
      fc.bigInt({ min: 0n, max: 1000000n }),
      namespaceStringsArb,
      parametersArb,
      (requestId, namespaceParts, parameters) => {
        const original: PublishNamespace = {
          type: MessageType.PUBLISH_NAMESPACE,
          requestId,
          trackNamespace: createTrackNamespace(namespaceParts),
          parameters,
        };

        const encoded = encodePublishNamespacePayload(original);
        const decoded = decodePublishNamespacePayload(encoded);

        assert.equal(decoded.type, MessageType.PUBLISH_NAMESPACE);
        assert.equal(decoded.requestId, requestId);
        assert.deepEqual(trackNamespaceToStrings(decoded.trackNamespace), namespaceParts);
        assert.equal(decoded.parameters.length, parameters.length);
        for (let i = 0; i < parameters.length; i++) {
          assert.equal(decoded.parameters[i].type, parameters[i].type);
          assert.deepEqual(decoded.parameters[i].value, parameters[i].value);
        }
      },
    ),
  );
});

test("PublishNamespaceDone のエンコード・デコードがラウンドトリップする", () => {
  fc.assert(
    fc.property(namespaceStringsArb, (namespaceParts) => {
      const original: PublishNamespaceDone = {
        type: MessageType.PUBLISH_NAMESPACE_DONE,
        trackNamespace: createTrackNamespace(namespaceParts),
      };

      const encoded = encodePublishNamespaceDonePayload(original);
      const decoded = decodePublishNamespaceDonePayload(encoded);

      assert.equal(decoded.type, MessageType.PUBLISH_NAMESPACE_DONE);
      assert.deepEqual(trackNamespaceToStrings(decoded.trackNamespace), namespaceParts);
    }),
  );
});

test("PublishNamespaceCancel のエンコード・デコードがラウンドトリップする", () => {
  fc.assert(
    fc.property(
      namespaceStringsArb,
      fc.bigInt({ min: 0n, max: 1000n }),
      fc.string({ minLength: 0, maxLength: 100 }),
      (namespaceParts, errorCode, reasonPhrase) => {
        const original: PublishNamespaceCancel = {
          type: MessageType.PUBLISH_NAMESPACE_CANCEL,
          trackNamespace: createTrackNamespace(namespaceParts),
          errorCode,
          reasonPhrase,
        };

        const encoded = encodePublishNamespaceCancelPayload(original);
        const decoded = decodePublishNamespaceCancelPayload(encoded);

        assert.equal(decoded.type, MessageType.PUBLISH_NAMESPACE_CANCEL);
        assert.deepEqual(trackNamespaceToStrings(decoded.trackNamespace), namespaceParts);
        assert.equal(decoded.errorCode, errorCode);
        assert.equal(decoded.reasonPhrase, reasonPhrase);
      },
    ),
  );
});

test("SubscribeNamespace のエンコード・デコードがラウンドトリップする", () => {
  fc.assert(
    fc.property(
      fc.bigInt({ min: 0n, max: 1000000n }),
      namespaceStringsArb,
      parametersArb,
      (requestId, namespaceParts, parameters) => {
        const original: SubscribeNamespace = {
          type: MessageType.SUBSCRIBE_NAMESPACE,
          requestId,
          trackNamespacePrefix: createTrackNamespace(namespaceParts),
          parameters,
        };

        const encoded = encodeSubscribeNamespacePayload(original);
        const decoded = decodeSubscribeNamespacePayload(encoded);

        assert.equal(decoded.type, MessageType.SUBSCRIBE_NAMESPACE);
        assert.equal(decoded.requestId, requestId);
        assert.deepEqual(trackNamespaceToStrings(decoded.trackNamespacePrefix), namespaceParts);
        assert.equal(decoded.parameters.length, parameters.length);
        for (let i = 0; i < parameters.length; i++) {
          assert.equal(decoded.parameters[i].type, parameters[i].type);
          assert.deepEqual(decoded.parameters[i].value, parameters[i].value);
        }
      },
    ),
  );
});

test("UnsubscribeNamespace のエンコード・デコードがラウンドトリップする", () => {
  fc.assert(
    fc.property(fc.bigInt({ min: 0n, max: 1000000n }), (requestId) => {
      const original: UnsubscribeNamespace = {
        type: MessageType.UNSUBSCRIBE_NAMESPACE,
        requestId,
      };

      const encoded = encodeUnsubscribeNamespacePayload(original);
      const decoded = decodeUnsubscribeNamespacePayload(encoded);

      assert.equal(decoded.type, MessageType.UNSUBSCRIBE_NAMESPACE);
      assert.equal(decoded.requestId, requestId);
    }),
  );
});
