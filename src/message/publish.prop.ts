/**
 * MOQT Publish Messages Property-Based Tests
 * draft-ietf-moq-transport-19 Section 10.10-10.11
 */

import { test, assert } from "vite-plus/test";
import * as fc from "fast-check";
import {
  encodePublishPayload,
  decodePublishPayload,
  encodePublishDonePayload,
  decodePublishDonePayload,
} from "./publish";
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
import { decodeRequestOkPayload, encodeRequestOkPayload } from "./session";

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
    type: fc.constant(0x03),
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
 * PUBLISH, SUBSCRIBE_OK, FETCH_OK に Track Properties が追加された。
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

/**
 * draft-ietf-moq-transport-19:
 * PUBLISH に Track Properties が追加された。
 * draft-ietf-moq-transport-19 Section 10 (Control Messages)
 */
test("Publish のエンコード・デコードがラウンドトリップする", () => {
  fc.assert(
    fc.property(
      fc.bigInt({ min: 0n, max: 1000000n }),
      namespaceStringsArb,
      trackNameArb,
      fc.bigInt({ min: 0n, max: 1000000n }),
      parametersArb,
      trackPropertiesArb,
      (requestId, namespaceParts, trackName, trackAlias, parameters, trackProperties) => {
        const original = {
          type: MessageType.PUBLISH as typeof MessageType.PUBLISH,
          requestId,
          trackNamespace: createTrackNamespace(namespaceParts),
          trackName,
          trackAlias,
          parameters,
          trackProperties,
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

test("PublishOk のエンコード・デコードがラウンドトリップする", () => {
  fc.assert(
    fc.property(parametersArb, (parameters) => {
      const original = {
        type: MessageType.REQUEST_OK as typeof MessageType.REQUEST_OK,
        parameters,
        trackProperties: [] as Property[],
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
 * draft-ietf-moq-transport-19 Section 10.11:
 * PUBLISH_DONE は双方向ストリーム上で送信されるため Request ID フィールドはない。
 */
test("PublishDone のエンコード・デコードがラウンドトリップする", () => {
  fc.assert(
    fc.property(
      fc.bigInt({ min: 0n, max: 100n }),
      fc.bigInt({ min: 0n, max: 1000000n }),
      fc.string({ minLength: 0, maxLength: 100 }),
      (statusCode, streamCount, reasonPhrase) => {
        const original = {
          type: MessageType.PUBLISH_DONE as typeof MessageType.PUBLISH_DONE,
          statusCode,
          streamCount,
          reasonPhrase,
        };

        const encoded = encodePublishDonePayload(original);
        const decoded = decodePublishDonePayload(encoded);

        assert.equal(decoded.type, MessageType.PUBLISH_DONE);
        assert.equal(decoded.statusCode, statusCode);
        assert.equal(decoded.streamCount, streamCount);
        assert.equal(decoded.reasonPhrase, reasonPhrase);
      },
    ),
  );
});

/**
 * draft-ietf-moq-transport-19 Section 10:
 * "If the length does not match the length of the Message Body,
 *  the receiver MUST close the session with a PROTOCOL_VIOLATION."
 * Error Reason は PUBLISH_DONE ペイロードの最後のフィールドであり、
 * その後ろに後続データがあると消費バイト数が Message Body 長と一致しないため違反となる。
 * 正常な PUBLISH_DONE の後ろに後続バイト列を連結すると
 * ProtocolViolationError を throw することを検証する。
 */
test("PUBLISH_DONE の末尾に後続データがあると ProtocolViolationError を throw する", () => {
  fc.assert(
    fc.property(
      fc.bigInt({ min: 0n, max: 100n }),
      fc.bigInt({ min: 0n, max: 1000000n }),
      fc.string({ minLength: 0, maxLength: 100 }),
      fc.uint8Array({ minLength: 1, maxLength: 1000 }),
      (statusCode, streamCount, reasonPhrase, trailing) => {
        const original = {
          type: MessageType.PUBLISH_DONE as typeof MessageType.PUBLISH_DONE,
          statusCode,
          streamCount,
          reasonPhrase,
        };

        const encoded = encodePublishDonePayload(original);
        // 正常な PUBLISH_DONE の後ろに 1 バイト以上の後続データを連結する
        const withTrailing = new Uint8Array(encoded.length + trailing.length);
        withTrailing.set(encoded, 0);
        withTrailing.set(trailing, encoded.length);

        assert.throws(() => decodePublishDonePayload(withTrailing), ProtocolViolationError);
      },
    ),
  );
});

/**
 * draft-ietf-moq-transport-19 Section 1.4.4:
 * "If an endpoint receives a length exceeding the maximum, it MUST close
 *  the session with a PROTOCOL_VIOLATION"
 * Reason Phrase Length が上限 (1024) を超える PUBLISH_DONE を受信すると
 * decodePublishDonePayload が ProtocolViolationError を throw することを検証する。
 */
test("PUBLISH_DONE の Reason Phrase 長が上限超過だと ProtocolViolationError を throw する", () => {
  // statusCode + streamCount + reasonLen(>1024) を組み立てる。
  // reasonLen のチェックは Reason Phrase バイト読み取り前に行われるため、
  // 実際の Reason Phrase バイトは不要。
  const data = new Uint8Array([...encodeVarint(0n), ...encodeVarint(0n), ...encodeVarint(1025n)]);
  assert.throws(() => decodePublishDonePayload(data), ProtocolViolationError);
});
