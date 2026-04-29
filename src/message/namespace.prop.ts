/**
 * MOQT Namespace Messages Property-Based Tests
 * draft-ietf-moq-transport-17 Section 9.17 (PUBLISH_NAMESPACE) — 9.21 (PUBLISH_BLOCKED)
 */

import { test, assert } from "vite-plus/test";
import * as fc from "fast-check";
import {
  type Namespace,
  type NamespaceDone,
  type PublishNamespace,
  type SubscribeNamespace,
  decodeNamespaceDonePayload,
  decodeNamespacePayload,
  decodePublishNamespacePayload,
  decodeSubscribeNamespacePayload,
  encodeNamespaceDonePayload,
  encodeNamespacePayload,
  encodePublishNamespacePayload,
  encodeSubscribeNamespacePayload,
} from "./namespace";
import { createTrackNamespace, trackNamespaceToStrings, type Parameter } from "./parameter";
import { MessageType, NamespaceSubscribeMode } from "./types";
import { encodeVarint } from "../varint";
import { ControlStreamReader, ControlStreamWriter } from "../controlStream";

/**
 * Message Parameter の arbitrary
 *
 * draft-ietf-moq-transport-17 Section 9.3 (Message Parameter):
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
const namespaceStringsArb = fc.array(fc.string({ minLength: 1, maxLength: 20 }), {
  minLength: 0,
  maxLength: 5,
});

/**
 * SUBSCRIBE_NAMESPACE 用のネームスペース arbitrary
 *
 * draft-ietf-moq-transport-17:
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
 * draft-ietf-moq-transport-17 Section 9.21:
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
 * draft-ietf-moq-transport-17 Section 9.25:
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
      fc.bigInt({ min: 0n, max: 1000000n }),
      namespaceStringsArb,
      parametersArb,
      (requestId, requiredRequestIdDelta, namespaceParts, parameters) => {
        const original: PublishNamespace = {
          type: MessageType.PUBLISH_NAMESPACE,
          requestId,
          requiredRequestIdDelta,
          trackNamespace: createTrackNamespace(namespaceParts),
          parameters,
        };

        const encoded = encodePublishNamespacePayload(original);
        const decoded = decodePublishNamespacePayload(encoded);

        assert.equal(decoded.type, MessageType.PUBLISH_NAMESPACE);
        assert.equal(decoded.requestId, requestId);
        assert.equal(decoded.requiredRequestIdDelta, requiredRequestIdDelta);
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
 * draft-ietf-moq-transport-17 Section 9.18:
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
 * draft-ietf-moq-transport-17 Section 9.19:
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
 * draft-ietf-moq-transport-17 Section 9.20:
 * SUBSCRIBE_NAMESPACE は新しい双方向ストリームで送信される。
 * Subscribe Options フィールドで PUBLISH (0x00)、NAMESPACE (0x01)、BOTH (0x02) を指定できる。
 * 空のネームスペース（ワイルドカード）も許可される。
 * https://github.com/moq-wg/moq-transport/pull/1393
 */
test("SubscribeNamespace のエンコード・デコードがラウンドトリップする", () => {
  fc.assert(
    fc.property(
      fc.bigInt({ min: 0n, max: 1000000n }),
      fc.bigInt({ min: 0n, max: 1000000n }),
      namespacePrefixStringsArb,
      namespaceSubscribeModeArb,
      parametersArb,
      (requestId, requiredRequestIdDelta, namespaceParts, subscribeOptions, parameters) => {
        const original: SubscribeNamespace = {
          type: MessageType.SUBSCRIBE_NAMESPACE,
          requestId,
          requiredRequestIdDelta,
          trackNamespacePrefix: createTrackNamespace(namespaceParts),
          subscribeOptions,
          parameters,
        };

        const encoded = encodeSubscribeNamespacePayload(original);
        const decoded = decodeSubscribeNamespacePayload(encoded);

        assert.equal(decoded.type, MessageType.SUBSCRIBE_NAMESPACE);
        assert.equal(decoded.requestId, requestId);
        assert.equal(decoded.requiredRequestIdDelta, requiredRequestIdDelta);
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

/**
 * draft-ietf-moq-transport-17 Section 9.20:
 * SUBSCRIBE_NAMESPACE Message のフレーミングは Type (vi64) + Length (16-bit big-endian) + Payload。
 * Length が可変長整数でエンコードされていると受信側で misparse されるため、
 * ControlStreamWriter でフレーミングしたバイト列が ControlStreamReader で正しくパースできることを検証する。
 */
test("SubscribeNamespace のフレーミングが ControlStreamReader で復元できる", () => {
  fc.assert(
    fc.property(
      fc.bigInt({ min: 0n, max: 1000000n }),
      fc.bigInt({ min: 0n, max: 1000000n }),
      namespacePrefixStringsArb,
      namespaceSubscribeModeArb,
      parametersArb,
      (requestId, requiredRequestIdDelta, namespaceParts, subscribeOptions, parameters) => {
        const original: SubscribeNamespace = {
          type: MessageType.SUBSCRIBE_NAMESPACE,
          requestId,
          requiredRequestIdDelta,
          trackNamespacePrefix: createTrackNamespace(namespaceParts),
          subscribeOptions,
          parameters,
        };

        const payload = encodeSubscribeNamespacePayload(original);
        const writer = new ControlStreamWriter();
        const framed = writer.encode(MessageType.SUBSCRIBE_NAMESPACE, payload);

        const reader = new ControlStreamReader();
        const messages = reader.feed(framed);

        assert.equal(messages.length, 1);
        assert.equal(messages[0].type, MessageType.SUBSCRIBE_NAMESPACE);
        assert.deepEqual(messages[0].payload, payload);

        const decoded = decodeSubscribeNamespacePayload(messages[0].payload);
        assert.equal(decoded.requestId, requestId);
        assert.equal(decoded.requiredRequestIdDelta, requiredRequestIdDelta);
        assert.deepEqual(trackNamespaceToStrings(decoded.trackNamespacePrefix), namespaceParts);
        assert.equal(decoded.subscribeOptions, subscribeOptions);
      },
    ),
  );
});
