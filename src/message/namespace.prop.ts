/**
 * MOQT Namespace Messages Property-Based Tests
 * draft-ietf-moq-transport-16 Section 9.20-9.24
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

/**
 * SUBSCRIBE_NAMESPACE 用のネームスペース arbitrary
 *
 * draft-ietf-moq-transport-16:
 * Track Namespace Prefix は 0〜32 タプルを許可する（空のネームスペースも可）。
 * https://github.com/moq-wg/moq-transport/pull/1393
 */
const namespacePrefixStringsArb = fc.array(fc.string({ minLength: 1, maxLength: 20 }), {
  minLength: 0,
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

/**
 * draft-ietf-moq-transport-16:
 * PUBLISH_NAMESPACE_DONE に Request ID が追加された。
 * https://github.com/moq-wg/moq-transport/pull/1329
 */
test("PublishNamespaceDone のエンコード・デコードがラウンドトリップする", () => {
  fc.assert(
    fc.property(
      fc.bigInt({ min: 0n, max: 1000000n }),
      namespaceStringsArb,
      (requestId, namespaceParts) => {
        const original: PublishNamespaceDone = {
          type: MessageType.PUBLISH_NAMESPACE_DONE,
          requestId,
          trackNamespace: createTrackNamespace(namespaceParts),
        };

        const encoded = encodePublishNamespaceDonePayload(original);
        const decoded = decodePublishNamespaceDonePayload(encoded);

        assert.equal(decoded.type, MessageType.PUBLISH_NAMESPACE_DONE);
        assert.equal(decoded.requestId, requestId);
        assert.deepEqual(trackNamespaceToStrings(decoded.trackNamespace), namespaceParts);
      },
    ),
  );
});

/**
 * draft-ietf-moq-transport-16:
 * PUBLISH_NAMESPACE_CANCEL に Request ID が追加された。
 * https://github.com/moq-wg/moq-transport/pull/1329
 */
test("PublishNamespaceCancel のエンコード・デコードがラウンドトリップする", () => {
  fc.assert(
    fc.property(
      fc.bigInt({ min: 0n, max: 1000000n }),
      namespaceStringsArb,
      fc.bigInt({ min: 0n, max: 1000n }),
      fc.string({ minLength: 0, maxLength: 100 }),
      (requestId, namespaceParts, errorCode, reasonPhrase) => {
        const original: PublishNamespaceCancel = {
          type: MessageType.PUBLISH_NAMESPACE_CANCEL,
          requestId,
          trackNamespace: createTrackNamespace(namespaceParts),
          errorCode,
          reasonPhrase,
        };

        const encoded = encodePublishNamespaceCancelPayload(original);
        const decoded = decodePublishNamespaceCancelPayload(encoded);

        assert.equal(decoded.type, MessageType.PUBLISH_NAMESPACE_CANCEL);
        assert.equal(decoded.requestId, requestId);
        assert.deepEqual(trackNamespaceToStrings(decoded.trackNamespace), namespaceParts);
        assert.equal(decoded.errorCode, errorCode);
        assert.equal(decoded.reasonPhrase, reasonPhrase);
      },
    ),
  );
});

/**
 * draft-ietf-moq-transport-16:
 * SUBSCRIBE_NAMESPACE では空のネームスペース（ワイルドカード）も許可される。
 * https://github.com/moq-wg/moq-transport/pull/1393
 */
test("SubscribeNamespace のエンコード・デコードがラウンドトリップする", () => {
  fc.assert(
    fc.property(
      fc.bigInt({ min: 0n, max: 1000000n }),
      namespacePrefixStringsArb,
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
