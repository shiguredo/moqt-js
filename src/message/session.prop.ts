/**
 * MOQT Session Messages Property-Based Tests
 * draft-ietf-moq-transport-18 Section 10.4 (GOAWAY) — 10.6 (REQUEST_ERROR)
 */

import { test, assert } from "vite-plus/test";
import * as fc from "fast-check";
import {
  type Goaway,
  type Redirect,
  type RequestError,
  type RequestOk,
  decodeGoawayPayload,
  decodeRequestErrorPayload,
  decodeRequestOkPayload,
  encodeGoawayPayload,
  encodeRequestErrorPayload,
  encodeRequestOkPayload,
} from "./session";
import { type Parameter, createTrackNamespace, trackNamespaceToStrings } from "./parameter";
import { MessageType } from "./types";
import { encodeVarint } from "../varint";
import { type Property, TrackPropertyId } from "../properties";
import { ProtocolViolationError } from "../error";

/**
 * Message Parameter の arbitrary
 *
 * draft-ietf-moq-transport-18 Section 10.2:
 * 各パラメータ型が独自の Value エンコーディングを定義する。
 */
const varintParameterArb = fc
  .record({
    type: fc.constantFrom(0x02, 0x04, 0x08, 0x32),
    varintValue: fc.bigInt({ min: 0n, max: 1000000n }),
  })
  .map(({ type, varintValue }) => ({ type, value: encodeVarint(varintValue) }));

// draft-ietf-moq-transport-18 §10.2.8 / §10.2.12: 値域制約に従う arbitrary
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
 * draft-ietf-moq-transport-18 Section 10.4:
 * GOAWAY に Timeout フィールドが追加された。
 * draft-ietf-moq-transport-18 Section 10.4
 */
test("Goaway のエンコード・デコードがラウンドトリップする", () => {
  fc.assert(
    fc.property(
      fc.string({ minLength: 0, maxLength: 200 }),
      fc.bigInt({ min: 0n, max: 1000000n }),
      fc.option(fc.bigInt({ min: 0n, max: 1000000n }), { nil: null }),
      (newSessionUri, timeout, requestId) => {
        const original: Goaway = {
          type: MessageType.GOAWAY,
          newSessionUri,
          timeout,
          requestId,
        };

        const encoded = encodeGoawayPayload(original);
        const decoded = decodeGoawayPayload(encoded);

        assert.equal(decoded.type, MessageType.GOAWAY);
        assert.equal(decoded.newSessionUri, newSessionUri);
        assert.equal(decoded.timeout, timeout);
        assert.equal(decoded.requestId, requestId);
      },
    ),
  );
});

/**
 * draft-ietf-moq-transport-18 Section 10.5:
 * REQUEST_OK に Track Properties が追加された。
 * draft-ietf-moq-transport-18 Section 10.5
 */
test("RequestOk のエンコード・デコードがラウンドトリップする（空 Track Properties）", () => {
  fc.assert(
    fc.property(parametersArb, (parameters) => {
      const original: RequestOk = {
        type: MessageType.REQUEST_OK,
        parameters,
        trackProperties: [],
      };

      const encoded = encodeRequestOkPayload(original);
      const decoded = decodeRequestOkPayload(encoded);

      assert.equal(decoded.type, MessageType.REQUEST_OK);
      assert.equal(decoded.parameters.length, parameters.length);
      for (let i = 0; i < parameters.length; i++) {
        assert.equal(decoded.parameters[i].type, parameters[i].type);
        assert.deepEqual(decoded.parameters[i].value, parameters[i].value);
      }
      assert.equal(decoded.trackProperties.length, 0);
    }),
  );
});

/**
 * draft-ietf-moq-transport-18 Section 10.5 (REQUEST_OK):
 * REQUEST_OK に Track Properties が追加された。
 * 非空 Track Properties のエンコード・デコードが正しくラウンドトリップすることを検証する。
 */
test("RequestOk のエンコード・デコードがラウンドトリップする（非空 Track Properties）", () => {
  fc.assert(
    fc.property(
      parametersArb,
      fc.array(propertyArb, { minLength: 1, maxLength: 3 }),
      (parameters, trackProperties) => {
        const original: RequestOk = {
          type: MessageType.REQUEST_OK,
          parameters,
          trackProperties,
        };

        const encoded = encodeRequestOkPayload(original);
        const decoded = decodeRequestOkPayload(encoded);

        assert.equal(decoded.type, MessageType.REQUEST_OK);
        assert.equal(decoded.parameters.length, parameters.length);
        for (let i = 0; i < parameters.length; i++) {
          assert.equal(decoded.parameters[i].type, parameters[i].type);
          assert.deepEqual(decoded.parameters[i].value, parameters[i].value);
        }
        assert.equal(decoded.trackProperties.length, trackProperties.length);
        // Track Properties はソートされるため、ソート後の値を比較
        const sortedOriginal = [...trackProperties].sort((a, b) =>
          a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
        );
        for (let i = 0; i < sortedOriginal.length; i++) {
          assert.equal(decoded.trackProperties[i].id, sortedOriginal[i].id);
          if (sortedOriginal[i].value !== undefined) {
            assert.equal(decoded.trackProperties[i].value, sortedOriginal[i].value);
          }
          if (sortedOriginal[i].data !== undefined) {
            assert.deepEqual(decoded.trackProperties[i].data, sortedOriginal[i].data);
          }
        }
      },
    ),
  );
});

/**
 * Track Properties arbitrary
 *
 * draft-ietf-moq-transport-18 Section 10.5:
 * REQUEST_OK は Track Properties を末尾に含む場合がある。
 */
const evenPropertyArb = fc
  .record({
    id: fc
      .bigInt({ min: 0n, max: 100n })
      .map((n) => n * 2n)
      .filter(
        (id) =>
          id !== TrackPropertyId.DEFAULT_PUBLISHER_PRIORITY &&
          id !== TrackPropertyId.DEFAULT_PUBLISHER_GROUP_ORDER &&
          id !== TrackPropertyId.DYNAMIC_GROUPS,
      ),
    value: fc.bigInt({ min: 0n, max: 1000000n }),
  })
  .map(({ id, value }) => ({ id, value }));

const oddPropertyArb = fc
  .record({
    id: fc.bigInt({ min: 0n, max: 100n }).map((n) => n * 2n + 1n),
    data: fc.uint8Array({ minLength: 0, maxLength: 20 }),
  })
  .map(({ id, data }) => ({ id, data }));

const propertyArb: fc.Arbitrary<Property> = fc.oneof(evenPropertyArb, oddPropertyArb);

/**
 * draft-ietf-moq-transport-18 Section 10.6.2:
 * REQUEST_ERROR に Redirect が含まれる場合（REDIRECT エラーコード）
 */
test("REQUEST_ERROR with Redirect のエンコード・デコードがラウンドトリップする", () => {
  fc.assert(
    fc.property(
      fc.bigInt({ min: 0n, max: 1000000n }),
      fc.string({ minLength: 0, maxLength: 200 }),
      fc.string({ minLength: 0, maxLength: 100 }),
      fc.array(fc.string({ minLength: 1, maxLength: 20 }), { minLength: 0, maxLength: 5 }),
      fc.uint8Array({ minLength: 0, maxLength: 50 }),
      (retryInterval, reasonPhrase, connectUri, namespaceParts, trackName) => {
        const original: RequestError = {
          type: MessageType.REQUEST_ERROR,
          errorCode: 0x34n, // REDIRECT
          retryInterval,
          reasonPhrase,
          redirect: {
            connectUri,
            trackNamespace: createTrackNamespace(namespaceParts),
            trackName,
          },
        };

        const encoded = encodeRequestErrorPayload(original);
        const decoded = decodeRequestErrorPayload(encoded);

        assert.equal(decoded.type, MessageType.REQUEST_ERROR);
        assert.equal(decoded.errorCode, 0x34n);
        assert.equal(decoded.retryInterval, retryInterval);
        assert.equal(decoded.reasonPhrase, reasonPhrase);
        assert.isDefined(decoded.redirect);
        assert.equal(decoded.redirect!.connectUri, connectUri);
        assert.deepEqual(trackNamespaceToStrings(decoded.redirect!.trackNamespace), namespaceParts);
        assert.deepEqual(decoded.redirect!.trackName, trackName);
      },
    ),
  );
});

/**
 * draft-ietf-moq-transport-18 Section 10.6:
 * REQUEST_ERROR から Request ID が削除された。
 * draft-ietf-moq-transport-18 Section 10.1
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

/**
 * draft-ietf-moq-transport-18 Section 10.6.2:
 * Error Code が REDIRECT 以外だが Redirect バイト列が存在する場合は
 * ProtocolViolationError を throw する。
 */
test("REDIRECT 以外のエラーコードで Redirect バイトが存在すると ProtocolViolationError を throw する", () => {
  fc.assert(
    fc.property(
      fc.bigInt({ min: 0n, max: 1000n }).filter((n) => n !== 0x34n),
      fc.bigInt({ min: 0n, max: 1000000n }),
      fc.string({ minLength: 0, maxLength: 200 }),
      (errorCode, retryInterval, reasonPhrase) => {
        const redirect: Redirect = {
          connectUri: "moqt://example.com",
          trackNamespace: createTrackNamespace(["test"]),
          trackName: new Uint8Array([1, 2, 3]),
        };
        const original: RequestError = {
          type: MessageType.REQUEST_ERROR,
          errorCode,
          retryInterval,
          reasonPhrase,
          redirect,
        };
        const encoded = encodeRequestErrorPayload(original);
        assert.throws(() => decodeRequestErrorPayload(encoded), ProtocolViolationError);
      },
    ),
  );
});
