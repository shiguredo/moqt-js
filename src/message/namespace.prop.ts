/**
 * MOQT Namespace Messages Property-Based Tests
 * draft-ietf-moq-transport-16 Section 9.20-9.25
 */

import { test, assert } from "vitest";
import * as fc from "fast-check";
import {
  type Namespace,
  type NamespaceDone,
  type PublishNamespace,
  type PublishNamespaceCancel,
  type PublishNamespaceDone,
  type SubscribeNamespace,
  decodeNamespaceDonePayload,
  decodeNamespacePayload,
  decodePublishNamespaceCancelPayload,
  decodePublishNamespaceDonePayload,
  decodePublishNamespacePayload,
  decodeSubscribeNamespacePayload,
  encodeNamespaceDonePayload,
  encodeNamespacePayload,
  encodePublishNamespaceCancelPayload,
  encodePublishNamespaceDonePayload,
  encodePublishNamespacePayload,
  encodeSubscribeNamespacePayload,
} from "./namespace";
import { createTrackNamespace, trackNamespaceToStrings, type Parameter } from "./parameter";
import { MessageType, NamespaceSubscribeMode } from "./types";
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

/**
 * NAMESPACE/NAMESPACE_DONE 用の Track Namespace Suffix arbitrary
 *
 * draft-ietf-moq-transport-16 Section 9.21:
 * Track Namespace Suffix は Track Namespace Prefix を除いた残りの部分。
 * 空も許容される。
 */
const namespaceSuffixStringsArb = fc.array(fc.string({ minLength: 1, maxLength: 20 }), {
  minLength: 0,
  maxLength: 5,
});

/**
 * NamespaceSubscribeMode の arbitrary
 *
 * draft-ietf-moq-transport-16 Section 9.25:
 * PUBLISH (0x00)、NAMESPACE (0x01)、BOTH (0x02)
 */
const namespaceSubscribeModeArb: fc.Arbitrary<NamespaceSubscribeMode> = fc.constantFrom(
  NamespaceSubscribeMode.PUBLISH,
  NamespaceSubscribeMode.NAMESPACE,
  NamespaceSubscribeMode.BOTH,
);

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
 * draft-ietf-moq-transport-16 Section 9.21:
 * NAMESPACE は SUBSCRIBE_NAMESPACE への応答として専用ストリームで送信される。
 * Track Namespace Prefix を除いた Suffix のみを含む。
 */
test("Namespace のエンコード・デコードがラウンドトリップする", () => {
  fc.assert(
    fc.property(namespaceSuffixStringsArb, (suffixParts) => {
      const original: Namespace = {
        type: MessageType.NAMESPACE,
        trackNamespaceSuffix: createTrackNamespace(suffixParts),
      };

      const encoded = encodeNamespacePayload(original);
      const decoded = decodeNamespacePayload(encoded);

      assert.equal(decoded.type, MessageType.NAMESPACE);
      assert.deepEqual(trackNamespaceToStrings(decoded.trackNamespaceSuffix), suffixParts);
    }),
  );
});

/**
 * draft-ietf-moq-transport-16 Section 9.22:
 * PUBLISH_NAMESPACE_DONE に Request ID が追加された。
 * https://github.com/moq-wg/moq-transport/pull/1329
 */
test("PublishNamespaceDone のエンコード・デコードがラウンドトリップする", () => {
  fc.assert(
    fc.property(fc.bigInt({ min: 0n, max: 1000000n }), (requestId) => {
      const original: PublishNamespaceDone = {
        type: MessageType.PUBLISH_NAMESPACE_DONE,
        requestId,
      };

      const encoded = encodePublishNamespaceDonePayload(original);
      const decoded = decodePublishNamespaceDonePayload(encoded);

      assert.equal(decoded.type, MessageType.PUBLISH_NAMESPACE_DONE);
      assert.equal(decoded.requestId, requestId);
    }),
  );
});

/**
 * draft-ietf-moq-transport-16 Section 9.23:
 * NAMESPACE_DONE は SUBSCRIBE_NAMESPACE への応答として専用ストリームで送信される。
 * Track Namespace Prefix を除いた Suffix のみを含む。
 */
test("NamespaceDone のエンコード・デコードがラウンドトリップする", () => {
  fc.assert(
    fc.property(namespaceSuffixStringsArb, (suffixParts) => {
      const original: NamespaceDone = {
        type: MessageType.NAMESPACE_DONE,
        trackNamespaceSuffix: createTrackNamespace(suffixParts),
      };

      const encoded = encodeNamespaceDonePayload(original);
      const decoded = decodeNamespaceDonePayload(encoded);

      assert.equal(decoded.type, MessageType.NAMESPACE_DONE);
      assert.deepEqual(trackNamespaceToStrings(decoded.trackNamespaceSuffix), suffixParts);
    }),
  );
});

/**
 * draft-ietf-moq-transport-16 Section 9.24:
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
 * draft-ietf-moq-transport-16 Section 9.25:
 * SUBSCRIBE_NAMESPACE は新しい双方向ストリームで送信される。
 * Subscribe Options フィールドで PUBLISH (0x00)、NAMESPACE (0x01)、BOTH (0x02) を指定できる。
 * 空のネームスペース（ワイルドカード）も許可される。
 * https://github.com/moq-wg/moq-transport/pull/1393
 */
test("SubscribeNamespace のエンコード・デコードがラウンドトリップする", () => {
  fc.assert(
    fc.property(
      fc.bigInt({ min: 0n, max: 1000000n }),
      namespacePrefixStringsArb,
      namespaceSubscribeModeArb,
      parametersArb,
      (requestId, namespaceParts, subscribeOptions, parameters) => {
        const original: SubscribeNamespace = {
          type: MessageType.SUBSCRIBE_NAMESPACE,
          requestId,
          trackNamespacePrefix: createTrackNamespace(namespaceParts),
          subscribeOptions,
          parameters,
        };

        const encoded = encodeSubscribeNamespacePayload(original);
        const decoded = decodeSubscribeNamespacePayload(encoded);

        assert.equal(decoded.type, MessageType.SUBSCRIBE_NAMESPACE);
        assert.equal(decoded.requestId, requestId);
        assert.deepEqual(trackNamespaceToStrings(decoded.trackNamespacePrefix), namespaceParts);
        assert.equal(decoded.subscribeOptions, subscribeOptions);
        assert.equal(decoded.parameters.length, parameters.length);
        for (let i = 0; i < parameters.length; i++) {
          assert.equal(decoded.parameters[i].type, parameters[i].type);
          assert.deepEqual(decoded.parameters[i].value, parameters[i].value);
        }
      },
    ),
  );
});
