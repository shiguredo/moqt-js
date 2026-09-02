/**
 * MOQT Subscribe Messages Property-Based Tests
 * draft-ietf-moq-transport-19 Section 10.7-10.9
 */

import { test, assert } from "vite-plus/test";
import * as fc from "fast-check";
import {
  encodeSubscribePayload,
  decodeSubscribePayload,
  encodeSubscribeOkPayload,
  decodeSubscribeOkPayload,
  encodeRequestUpdatePayload,
  decodeRequestUpdatePayload,
} from "./subscribe";
import {
  createTrackNamespace,
  trackNamespaceToStrings,
  encodeLocationFilterParameter,
  type Parameter,
} from "./parameter";
import { MessageType } from "./types";
import { encodeVarint } from "../varint";
import { ProtocolViolationError } from "../error";
import { type Property, MOQTPropertyId, TrackPropertyId } from "../properties";

/**
 * Message Parameter の arbitrary
 *
 * draft-ietf-moq-transport-19 Section 10.2:
 * 各パラメータ型が独自の Value エンコーディングを定義する。
 */
const varintParameterArb = fc
  .record({
    type: fc.constantFrom(0x02, 0x04, 0x06, 0x08, 0x32),
    varintValue: fc.bigInt({ min: 0n, max: 1000000n }),
  })
  .map(({ type, varintValue }) => ({ type, value: encodeVarint(varintValue) }));

// draft-ietf-moq-transport-19 §10.2.8 / §10.2.17: 値域制約に従う arbitrary
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
    type: fc.constantFrom(0x03, 0x34),
    value: fc.uint8Array({ minLength: 0, maxLength: 20 }),
  })
  .map(({ type, value }) => ({ type, value }));

/**
 * LOCATION_FILTER (0x21) パラメータの arbitrary
 *
 * draft-ietf-moq-transport-20 §5.1.2: Value は「Length + optional vi64 フィールド」の
 * 1 Length 構造。encodeLocationFilter の出力 (内部 Length と整合したバイト列) で
 * 構築する (生バイト列の任意生成は内部 Length 検証と衝突する)。
 */
const locationFilterParameterArb = fc
  .record({
    startGroup: fc.bigInt({ min: 0n, max: 1000000n }),
    startObject: fc.bigInt({ min: 0n, max: 1000000n }),
  })
  .map(({ startGroup, startObject }) => encodeLocationFilterParameter({ startGroup, startObject }));

const messageParameterArb: fc.Arbitrary<Parameter> = fc.oneof(
  varintParameterArb,
  uint8ParameterArb,
  locationParameterArb,
  lengthPrefixedParameterArb,
  locationFilterParameterArb,
);

// delta encoding では type は昇順かつ一意である必要がある
const parametersArb = fc
  .array(messageParameterArb, { minLength: 0, maxLength: 3 })
  .map((params) => {
    const sorted = [...params].sort((a, b) => a.type - b.type);
    return sorted.filter((param, index) => index === 0 || param.type !== sorted[index - 1].type);
  });

/**
 * Track Properties arbitrary
 *
 * draft-ietf-moq-transport-19:
 * SUBSCRIBE_OK に Track Properties が追加された。
 * draft-ietf-moq-transport-19 Section 10 (Control Messages)
 */
// 値域制約のある Track Property は除外する (validateTrackPropertyValue で
// ProtocolViolationError になりラウンドトリップが成立しないため)
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
    // IMMUTABLE_PROPERTIES (0x0b) は data に再帰的に IMMUTABLE_PROPERTIES を含むと
    // decodeProperties が MalformedTrackError を投げてラウンドトリップが成立しないため除外する
    id: fc
      .bigInt({ min: 0n, max: 100n })
      .map((n) => n * 2n + 1n)
      .filter((id) => id !== MOQTPropertyId.IMMUTABLE_PROPERTIES),
    data: fc.uint8Array({ minLength: 0, maxLength: 20 }),
  })
  .map(({ id, data }) => ({ id, data }));

const propertyArb: fc.Arbitrary<Property> = fc.oneof(evenPropertyArb, oddPropertyArb);

const trackPropertiesArb = fc.array(propertyArb, { minLength: 0, maxLength: 3 });

/**
 * draft-ietf-moq-transport-19 Section 2.3:
 * ゼロ要素 (空) のネームスペースを許可する。
 * draft-ietf-moq-transport-19 Section 10 (Control Messages)
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

/**
 * draft-ietf-moq-transport-19:
 * SUBSCRIBE_OK に Track Properties が追加された。
 * draft-ietf-moq-transport-19 Section 10 (Control Messages)
 */
test("SubscribeOk のエンコード・デコードがラウンドトリップする", () => {
  fc.assert(
    fc.property(
      fc.bigInt({ min: 0n, max: 1000000n }),
      parametersArb,
      trackPropertiesArb,
      (trackAlias, parameters, trackProperties) => {
        const original = {
          type: MessageType.SUBSCRIBE_OK as typeof MessageType.SUBSCRIBE_OK,
          trackAlias,
          parameters,
          trackProperties,
        };

        const encoded = encodeSubscribeOkPayload(original);
        const decoded = decodeSubscribeOkPayload(encoded);

        assert.equal(decoded.type, MessageType.SUBSCRIBE_OK);
        assert.equal(decoded.trackAlias, trackAlias);
        assert.equal(decoded.parameters.length, parameters.length);
        for (let i = 0; i < parameters.length; i++) {
          assert.equal(decoded.parameters[i].type, parameters[i].type);
          assert.deepEqual(decoded.parameters[i].value, parameters[i].value);
        }
        // Track Properties はソートされるため、ソート後の値を比較
        const sortedOriginal = [...trackProperties].sort((a, b) =>
          a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
        );
        assert.equal(decoded.trackProperties.length, trackProperties.length);
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
 * draft-ietf-moq-transport-19 Section 10:
 * "If the length does not match the length of the Message Body,
 *  the receiver MUST close the session with a PROTOCOL_VIOLATION."
 * Parameters は SUBSCRIBE ペイロードの最後のフィールドであり、
 * その後ろに後続データがあると消費バイト数が Message Body 長と一致しないため違反となる。
 * 正常な SUBSCRIBE の後ろに後続バイト列を連結すると
 * ProtocolViolationError を throw することを検証する。
 */
test("SUBSCRIBE の末尾に後続データがあると ProtocolViolationError を throw する", () => {
  fc.assert(
    fc.property(
      fc.bigInt({ min: 0n, max: 1000000n }),
      namespaceStringsArb,
      trackNameArb,
      parametersArb,
      fc.uint8Array({ minLength: 1, maxLength: 1000 }),
      (requestId, namespaceParts, trackName, parameters, trailing) => {
        const original = {
          type: MessageType.SUBSCRIBE as typeof MessageType.SUBSCRIBE,
          requestId,
          trackNamespace: createTrackNamespace(namespaceParts),
          trackName,
          parameters,
        };

        const encoded = encodeSubscribePayload(original);
        // 正常な SUBSCRIBE の後ろに 1 バイト以上の後続データを連結する
        const withTrailing = new Uint8Array(encoded.length + trailing.length);
        withTrailing.set(encoded, 0);
        withTrailing.set(trailing, encoded.length);

        assert.throws(() => decodeSubscribePayload(withTrailing), ProtocolViolationError);
      },
    ),
  );
});

/**
 * draft-ietf-moq-transport-19 Section 10.9:
 * REQUEST_UPDATE は既存のリクエスト（SUBSCRIBE, PUBLISH, FETCH など）の
 * パラメータを後から変更するために使用する。
 * 更新対象のリクエストは同じ bidi stream で特定される。
 */
test("RequestUpdate のエンコード・デコードがラウンドトリップする", () => {
  fc.assert(
    fc.property(fc.bigInt({ min: 0n, max: 1000000n }), parametersArb, (requestId, parameters) => {
      const original = {
        type: MessageType.REQUEST_UPDATE as typeof MessageType.REQUEST_UPDATE,
        requestId,
        parameters,
      };

      const encoded = encodeRequestUpdatePayload(original);
      const decoded = decodeRequestUpdatePayload(encoded);

      assert.equal(decoded.type, MessageType.REQUEST_UPDATE);
      assert.equal(decoded.requestId, requestId);
      assert.equal(decoded.parameters.length, parameters.length);
      for (let i = 0; i < parameters.length; i++) {
        assert.equal(decoded.parameters[i].type, parameters[i].type);
        assert.deepEqual(decoded.parameters[i].value, parameters[i].value);
      }
    }),
  );
});

/**
 * draft-ietf-moq-transport-19 Section 10:
 * "If the length does not match the length of the Message Body,
 *  the receiver MUST close the session with a PROTOCOL_VIOLATION."
 * Parameters は REQUEST_UPDATE ペイロードの最後のフィールドであり、
 * その後ろに後続データがあると消費バイト数が Message Body 長と一致しないため違反となる。
 * 正常な REQUEST_UPDATE の後ろに後続バイト列を連結すると
 * ProtocolViolationError を throw することを検証する。
 */
test("REQUEST_UPDATE の末尾に後続データがあると ProtocolViolationError を throw する", () => {
  fc.assert(
    fc.property(
      fc.bigInt({ min: 0n, max: 1000000n }),
      parametersArb,
      fc.uint8Array({ minLength: 1, maxLength: 1000 }),
      (requestId, parameters, trailing) => {
        const original = {
          type: MessageType.REQUEST_UPDATE as typeof MessageType.REQUEST_UPDATE,
          requestId,
          parameters,
        };

        const encoded = encodeRequestUpdatePayload(original);
        // 正常な REQUEST_UPDATE の後ろに 1 バイト以上の後続データを連結する
        const withTrailing = new Uint8Array(encoded.length + trailing.length);
        withTrailing.set(encoded, 0);
        withTrailing.set(trailing, encoded.length);

        assert.throws(() => decodeRequestUpdatePayload(withTrailing), ProtocolViolationError);
      },
    ),
  );
});
