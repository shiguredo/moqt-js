/**
 * MOQT Session Messages Property-Based Tests
 * draft-ietf-moq-transport-17 Section 9.5-9.7
 */

import { test, assert } from "vite-plus/test";
import * as fc from "fast-check";
import {
  type Goaway,
  type RequestError,
  type RequestOk,
  decodeGoawayPayload,
  decodeRequestErrorPayload,
  decodeRequestOkPayload,
  encodeGoawayPayload,
  encodeRequestErrorPayload,
  encodeRequestOkPayload,
} from "./session";
import { type Parameter } from "./parameter";
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

// draft-ietf-moq-transport-17 §9.3.6 / §9.3.10: 値域制約に従う arbitrary
//   - FORWARD (0x10): 0 / 1
//   - SUBSCRIBER_PRIORITY (0x20): 0-255
//   - GROUP_ORDER (0x22): 0x1 / 0x2
const uint8ParameterArb = fc.oneof(
  fc
    .record({ type: fc.constant(0x10), byteValue: fc.constantFrom(0, 1) })
    .map(({ type, byteValue }) => ({ type, value: new Uint8Array([byteValue]) })),
  fc
    .record({ type: fc.constant(0x20), byteValue: fc.integer({ min: 0, max: 255 }) })
    .map(({ type, byteValue }) => ({ type, value: new Uint8Array([byteValue]) })),
  fc
    .record({ type: fc.constant(0x22), byteValue: fc.constantFrom(1, 2) })
    .map(({ type, byteValue }) => ({ type, value: new Uint8Array([byteValue]) })),
);

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
 * draft-ietf-moq-transport-17 Section 9.5:
 * GOAWAY に Timeout フィールドが追加された。
 * https://github.com/moq-wg/moq-transport/pull/1497
 */
test("Goaway のエンコード・デコードがラウンドトリップする", () => {
  fc.assert(
    fc.property(
      fc.string({ minLength: 0, maxLength: 200 }),
      fc.bigInt({ min: 0n, max: 1000000n }),
      (newSessionUri, timeout) => {
        const original: Goaway = {
          type: MessageType.GOAWAY,
          newSessionUri,
          timeout,
        };

        const encoded = encodeGoawayPayload(original);
        const decoded = decodeGoawayPayload(encoded);

        assert.equal(decoded.type, MessageType.GOAWAY);
        assert.equal(decoded.newSessionUri, newSessionUri);
        assert.equal(decoded.timeout, timeout);
      },
    ),
  );
});

/**
 * draft-ietf-moq-transport-17 Section 9.6:
 * REQUEST_OK から Request ID が削除された。
 * https://github.com/moq-wg/moq-transport/pull/1499
 */
test("RequestOk のエンコード・デコードがラウンドトリップする", () => {
  fc.assert(
    fc.property(parametersArb, (parameters) => {
      const original: RequestOk = {
        type: MessageType.REQUEST_OK,
        parameters,
      };

      const encoded = encodeRequestOkPayload(original);
      const decoded = decodeRequestOkPayload(encoded);

      assert.equal(decoded.type, MessageType.REQUEST_OK);
      assert.equal(decoded.parameters.length, parameters.length);
      for (let i = 0; i < parameters.length; i++) {
        assert.equal(decoded.parameters[i].type, parameters[i].type);
        assert.deepEqual(decoded.parameters[i].value, parameters[i].value);
      }
    }),
  );
});

/**
 * draft-ietf-moq-transport-17 Section 9.7:
 * REQUEST_ERROR から Request ID が削除された。
 * https://github.com/moq-wg/moq-transport/pull/1499
 *
 * Retry Interval: 再試行までに待つべきミリ秒 + 1
 * - 0: 再試行すべきではない
 * - 1 以上: 再試行可能（1 は即座の再試行を許可）
 */
test("RequestError のエンコード・デコードがラウンドトリップする", () => {
  fc.assert(
    fc.property(
      fc.bigInt({ min: 0n, max: 1000n }),
      fc.bigInt({ min: 0n, max: 1000000n }),
      fc.string({ minLength: 0, maxLength: 200 }),
      (errorCode, retryInterval, reasonPhrase) => {
        const original: RequestError = {
          type: MessageType.REQUEST_ERROR,
          errorCode,
          retryInterval,
          reasonPhrase,
        };

        const encoded = encodeRequestErrorPayload(original);
        const decoded = decodeRequestErrorPayload(encoded);

        assert.equal(decoded.type, MessageType.REQUEST_ERROR);
        assert.equal(decoded.errorCode, errorCode);
        assert.equal(decoded.retryInterval, retryInterval);
        assert.equal(decoded.reasonPhrase, reasonPhrase);
      },
    ),
  );
});
