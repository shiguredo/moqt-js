/**
 * MOQT Subscribe Messages Property-Based Tests
 * draft-ietf-moq-transport-17 Section 9.8-9.10
 */

import { test, assert } from "vite-plus/test";
import * as fc from "fast-check";
import {
  encodeSubscribePayload,
  decodeSubscribePayload,
  encodeRequestUpdatePayload,
  decodeRequestUpdatePayload,
} from "./subscribe";
import { createTrackNamespace, trackNamespaceToStrings, type Parameter } from "./parameter";
import { MessageType } from "./types";
import { encodeVarint } from "../varint";

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
 * draft-ietf-moq-transport-17 Section 2.3:
 * ゼロ要素 (空) のネームスペースを許可する。
 * https://github.com/moq-wg/moq-transport/pull/1472
 */
const namespaceStringsArb = fc.array(fc.string({ minLength: 1, maxLength: 20 }), {
  minLength: 0,
  maxLength: 5,
});

const trackNameArb = fc
  .string({ minLength: 1, maxLength: 50 })
  .map((s) => new TextEncoder().encode(s));

test("Subscribe のエンコード・デコードがラウンドトリップする", () => {
  fc.assert(
    fc.property(
      fc.bigInt({ min: 0n, max: 1000000n }),
      fc.bigInt({ min: 0n, max: 1000000n }),
      namespaceStringsArb,
      trackNameArb,
      parametersArb,
      (requestId, requiredRequestIdDelta, namespaceParts, trackName, parameters) => {
        const original = {
          type: MessageType.SUBSCRIBE as typeof MessageType.SUBSCRIBE,
          requestId,
          requiredRequestIdDelta,
          trackNamespace: createTrackNamespace(namespaceParts),
          trackName,
          parameters,
        };

        const encoded = encodeSubscribePayload(original);
        const decoded = decodeSubscribePayload(encoded);

        assert.equal(decoded.type, MessageType.SUBSCRIBE);
        assert.equal(decoded.requestId, requestId);
        assert.equal(decoded.requiredRequestIdDelta, requiredRequestIdDelta);
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

/**
 * draft-ietf-moq-transport-17 Section 9.10:
 * REQUEST_UPDATE は既存のリクエスト（SUBSCRIBE, PUBLISH, FETCH など）の
 * パラメータを後から変更するために使用する。
 * 更新対象のリクエストは同じ bidi stream で特定される。
 */
test("RequestUpdate のエンコード・デコードがラウンドトリップする", () => {
  fc.assert(
    fc.property(
      fc.bigInt({ min: 0n, max: 1000000n }),
      fc.bigInt({ min: 0n, max: 1000000n }),
      parametersArb,
      (requestId, requiredRequestIdDelta, parameters) => {
        const original = {
          type: MessageType.REQUEST_UPDATE as typeof MessageType.REQUEST_UPDATE,
          requestId,
          requiredRequestIdDelta,
          parameters,
        };

        const encoded = encodeRequestUpdatePayload(original);
        const decoded = decodeRequestUpdatePayload(encoded);

        assert.equal(decoded.type, MessageType.REQUEST_UPDATE);
        assert.equal(decoded.requestId, requestId);
        assert.equal(decoded.requiredRequestIdDelta, requiredRequestIdDelta);
        assert.equal(decoded.parameters.length, parameters.length);
        for (let i = 0; i < parameters.length; i++) {
          assert.equal(decoded.parameters[i].type, parameters[i].type);
          assert.deepEqual(decoded.parameters[i].value, parameters[i].value);
        }
      },
    ),
  );
});
