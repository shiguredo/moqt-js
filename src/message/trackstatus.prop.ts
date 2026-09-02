/**
 * MOQT TrackStatus Messages Property-Based Tests
 * draft-ietf-moq-transport-19 Section 10.14
 */

import { test, assert } from "vite-plus/test";
import * as fc from "fast-check";
import {
  type TrackStatus,
  decodeTrackStatusPayload,
  encodeTrackStatusPayload,
} from "./trackstatus";
import {
  createTrackNamespace,
  trackNamespaceToStrings,
  encodeLocationFilterParameter,
  type Parameter,
} from "./parameter";
import { MessageType } from "./types";
import { encodeVarint } from "../varint";
import { ProtocolViolationError } from "../error";

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
 * Message Parameter の arbitrary
 *
 * draft-ietf-moq-transport-19 Section 10.2:
 * 各パラメータ型が独自の Value エンコーディングを定義する。
 */
const varintParameterArb = fc
  .record({
    type: fc.constantFrom(0x02, 0x04, 0x08, 0x32),
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

test("TrackStatus のエンコード・デコードがラウンドトリップする", () => {
  fc.assert(
    fc.property(
      fc.bigInt({ min: 0n, max: 1000000n }),
      namespaceStringsArb,
      trackNameArb,
      parametersArb,
      (requestId, namespaceParts, trackName, parameters) => {
        const original: TrackStatus = {
          type: MessageType.TRACK_STATUS,
          requestId,
          trackNamespace: createTrackNamespace(namespaceParts),
          trackName,
          parameters,
        };

        const encoded = encodeTrackStatusPayload(original);
        const decoded = decodeTrackStatusPayload(encoded);

        assert.equal(decoded.type, MessageType.TRACK_STATUS);
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
 * draft-ietf-moq-transport-19 Section 10:
 * "If the length does not match the length of the Message Body,
 *  the receiver MUST close the session with a PROTOCOL_VIOLATION."
 * Parameters は TRACK_STATUS ペイロードの最後のフィールドであり、
 * その後ろに後続データがあると消費バイト数が Message Body 長と一致しないため違反となる。
 * 正常な TRACK_STATUS の後ろに後続バイト列を連結すると
 * ProtocolViolationError を throw することを検証する。
 */
test("TRACK_STATUS の末尾に後続データがあると ProtocolViolationError を throw する", () => {
  fc.assert(
    fc.property(
      fc.bigInt({ min: 0n, max: 1000000n }),
      namespaceStringsArb,
      trackNameArb,
      parametersArb,
      fc.uint8Array({ minLength: 1, maxLength: 1000 }),
      (requestId, namespaceParts, trackName, parameters, trailing) => {
        const original: TrackStatus = {
          type: MessageType.TRACK_STATUS,
          requestId,
          trackNamespace: createTrackNamespace(namespaceParts),
          trackName,
          parameters,
        };

        const encoded = encodeTrackStatusPayload(original);
        // 正常な TRACK_STATUS の後ろに 1 バイト以上の後続データを連結する
        const withTrailing = new Uint8Array(encoded.length + trailing.length);
        withTrailing.set(encoded, 0);
        withTrailing.set(trailing, encoded.length);

        assert.throws(() => decodeTrackStatusPayload(withTrailing), ProtocolViolationError);
      },
    ),
  );
});
