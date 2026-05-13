/**
 * MOQT Namespace Messages Property-Based Tests
 * draft-ietf-moq-transport-18 Section 10.15 (PUBLISH_NAMESPACE) — 10.20 (PUBLISH_BLOCKED)
 */

import { test, assert } from "vite-plus/test";
import * as fc from "fast-check";
import {
  type Namespace,
  type NamespaceDone,
  type PublishNamespace,
  type SubscribeNamespace,
  type SubscribeTracks,
  decodeNamespaceDonePayload,
  decodeNamespacePayload,
  decodePublishNamespacePayload,
  decodeSubscribeNamespacePayload,
  decodeSubscribeTracksPayload,
  encodeNamespaceDonePayload,
  encodeNamespacePayload,
  encodePublishNamespacePayload,
  encodeSubscribeNamespacePayload,
  encodeSubscribeTracksPayload,
} from "./namespace";
import { createTrackNamespace, trackNamespaceToStrings, type Parameter } from "./parameter";
import { MessageType } from "./types";
import { encodeVarint, decodeVarint } from "../varint";
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
 * draft-ietf-moq-transport-17 Section 2.3:
 * ゼロ要素 (空) のネームスペースを許可する。
 * draft-ietf-moq-transport-17 Section 9
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
 * draft-ietf-moq-transport-17 Section 9.18
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
 * draft-ietf-moq-transport-18 §10.15 (PUBLISH_NAMESPACE):
 * PUBLISH_NAMESPACE は新しい双方向ストリームの先頭メッセージとして送信される。
 * フレーミングは Type (vi64) + Length (16-bit big-endian) + Payload。
 * ControlStreamWriter でフレーミングしたバイト列が ControlStreamReader で
 * 正しくパースできることを検証する。
 */
test("PublishNamespace のフレーミングが ControlStreamReader で復元できる", () => {
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

        const payload = encodePublishNamespacePayload(original);
        const writer = new ControlStreamWriter();
        const framed = writer.encode(MessageType.PUBLISH_NAMESPACE, payload);

        const reader = new ControlStreamReader();
        const messages = reader.feed(framed);

        assert.equal(messages.length, 1);
        assert.equal(messages[0].type, MessageType.PUBLISH_NAMESPACE);
        assert.deepEqual(messages[0].payload, payload);

        const decoded = decodePublishNamespacePayload(messages[0].payload);
        assert.equal(decoded.requestId, requestId);
        assert.deepEqual(trackNamespaceToStrings(decoded.trackNamespace), namespaceParts);
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
 * draft-ietf-moq-transport-18 Section 10.18:
 * SUBSCRIBE_NAMESPACE は新しい双方向ストリームで送信される (0x50)。
 * Subscribe Options フィールドは draft-18 で廃止された。
 * 空のネームスペース（ワイルドカード）も許可される。
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

/**
 * draft-ietf-moq-transport-18 Section 10.18:
 * SUBSCRIBE_NAMESPACE Message のフレーミングは Type (vi64) + Length (16-bit big-endian) + Payload。
 * Length が可変長整数でエンコードされていると受信側で misparse されるため、
 * ControlStreamWriter でフレーミングしたバイト列が ControlStreamReader で正しくパースできることを検証する。
 */
test("SubscribeNamespace のフレーミングが ControlStreamReader で復元できる", () => {
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
        assert.deepEqual(trackNamespaceToStrings(decoded.trackNamespacePrefix), namespaceParts);
      },
    ),
  );
});

/**
 * draft-ietf-moq-transport-18 §10.18:
 * encodeSubscribeNamespacePayload は Subscribe Options をエンコードしない。
 * 想定: requestId / trackNamespacePrefix / parameters のみが直列化される。
 */
test("encodeSubscribeNamespacePayload は Subscribe Options を含まない", () => {
  fc.assert(
    fc.property(
      fc.bigInt({ min: 0n, max: 1000000n }),
      namespacePrefixStringsArb,
      (requestId, namespaceParts) => {
        const original: SubscribeNamespace = {
          type: MessageType.SUBSCRIBE_NAMESPACE,
          requestId,
          trackNamespacePrefix: createTrackNamespace(namespaceParts),
          parameters: [],
        };

        const encoded = encodeSubscribeNamespacePayload(original);

        // requestId / namespace の長さを消費した直後に
        // Number of Parameters (= 0) が来ることを確認する。
        let offset = 0;
        const [decodedRequestId, requestIdSize] = decodeVarint(encoded, offset);
        offset += requestIdSize;
        assert.equal(decodedRequestId, requestId);

        // Namespace tuple count
        const [tupleCount, tupleCountSize] = decodeVarint(encoded, offset);
        offset += tupleCountSize;
        // namespace 部分はスキップ
        for (let i = 0n; i < tupleCount; i++) {
          const [len, lenSize] = decodeVarint(encoded, offset);
          offset += lenSize + Number(len);
        }

        // 次は Subscribe Options ではなく Number of Parameters であることを確認する。
        // パラメータ数は 0 なので、次のバイトは 0x00 (varint 0)。
        const [paramCount] = decodeVarint(encoded, offset);
        assert.equal(paramCount, 0n);
      },
    ),
  );
});

/**
 * draft-ietf-moq-transport-18 Section 10.19:
 * SUBSCRIBE_TRACKS (0x51) は新しい双方向ストリームで送信される。
 * SUBSCRIBE_NAMESPACE と同構造で Subscribe Options を持たない。
 */
test("SubscribeTracks のエンコード・デコードがラウンドトリップする", () => {
  fc.assert(
    fc.property(
      fc.bigInt({ min: 0n, max: 1000000n }),
      namespacePrefixStringsArb,
      parametersArb,
      (requestId, namespaceParts, parameters) => {
        const original: SubscribeTracks = {
          type: MessageType.SUBSCRIBE_TRACKS,
          requestId,
          trackNamespacePrefix: createTrackNamespace(namespaceParts),
          parameters,
        };

        const encoded = encodeSubscribeTracksPayload(original);
        const decoded = decodeSubscribeTracksPayload(encoded);

        assert.equal(decoded.type, MessageType.SUBSCRIBE_TRACKS);
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

/**
 * draft-ietf-moq-transport-18 Section 10.19:
 * SUBSCRIBE_TRACKS Message のフレーミングは Type (vi64) + Length (16-bit big-endian) + Payload。
 */
test("SubscribeTracks のフレーミングが ControlStreamReader で復元できる", () => {
  fc.assert(
    fc.property(
      fc.bigInt({ min: 0n, max: 1000000n }),
      namespacePrefixStringsArb,
      parametersArb,
      (requestId, namespaceParts, parameters) => {
        const original: SubscribeTracks = {
          type: MessageType.SUBSCRIBE_TRACKS,
          requestId,
          trackNamespacePrefix: createTrackNamespace(namespaceParts),
          parameters,
        };

        const payload = encodeSubscribeTracksPayload(original);
        const writer = new ControlStreamWriter();
        const framed = writer.encode(MessageType.SUBSCRIBE_TRACKS, payload);

        const reader = new ControlStreamReader();
        const messages = reader.feed(framed);

        assert.equal(messages.length, 1);
        assert.equal(messages[0].type, MessageType.SUBSCRIBE_TRACKS);
        assert.deepEqual(messages[0].payload, payload);

        const decoded = decodeSubscribeTracksPayload(messages[0].payload);
        assert.equal(decoded.requestId, requestId);
        assert.deepEqual(trackNamespaceToStrings(decoded.trackNamespacePrefix), namespaceParts);
      },
    ),
  );
});

/**
 * draft-ietf-moq-transport-18 §10.19:
 * encodeSubscribeTracksPayload は Subscribe Options をエンコードしない。
 */
test("encodeSubscribeTracksPayload は Subscribe Options を含まない", () => {
  fc.assert(
    fc.property(
      fc.bigInt({ min: 0n, max: 1000000n }),
      namespacePrefixStringsArb,
      (requestId, namespaceParts) => {
        const original: SubscribeTracks = {
          type: MessageType.SUBSCRIBE_TRACKS,
          requestId,
          trackNamespacePrefix: createTrackNamespace(namespaceParts),
          parameters: [],
        };

        const encoded = encodeSubscribeTracksPayload(original);

        let offset = 0;
        const [decodedRequestId, requestIdSize] = decodeVarint(encoded, offset);
        offset += requestIdSize;
        assert.equal(decodedRequestId, requestId);

        const [tupleCount, tupleCountSize] = decodeVarint(encoded, offset);
        offset += tupleCountSize;
        for (let i = 0n; i < tupleCount; i++) {
          const [len, lenSize] = decodeVarint(encoded, offset);
          offset += lenSize + Number(len);
        }

        const [paramCount] = decodeVarint(encoded, offset);
        assert.equal(paramCount, 0n);
      },
    ),
  );
});
