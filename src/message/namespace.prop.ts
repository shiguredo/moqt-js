/**
 * MOQT Namespace Messages Property-Based Tests
 * draft-ietf-moq-transport-22 Section 9.14 (PUBLISH_NAMESPACE) — 9.19 (PUBLISH_SKIPPED)
 */

import { test, assert } from "vite-plus/test";
import * as fc from "fast-check";
import {
  type Namespace,
  type NamespaceDone,
  type PublishNamespace,
  type PublishSkipped,
  type SubscribeNamespace,
  type SubscribeTracks,
  decodeNamespaceDonePayload,
  decodeNamespacePayload,
  decodePublishNamespacePayload,
  decodePublishSkippedPayload,
  decodeSubscribeNamespacePayload,
  decodeSubscribeTracksPayload,
  encodeNamespaceDonePayload,
  encodeNamespacePayload,
  encodePublishNamespacePayload,
  encodePublishSkippedPayload,
  encodeSubscribeNamespacePayload,
  encodeSubscribeTracksPayload,
} from "./namespace";
import { createTrackNamespace, trackNamespaceToStrings } from "./parameter";
import { MessageType } from "./types";
import { decodeVarint } from "../varint";
import { ControlStreamReader, ControlStreamWriter } from "../controlStream";
import { parametersArb, namespaceStringsArb } from "./parameterArb";

/**
 * SUBSCRIBE_NAMESPACE 用のネームスペース arbitrary
 *
 * draft-ietf-moq-transport-22:
 * Track Namespace Prefix は 0〜32 タプルを許可する（空のネームスペースも可）。
 * draft-ietf-moq-transport-22 Section 9.15
 */
const namespacePrefixStringsArb = fc.array(fc.string({ minLength: 1, maxLength: 20 }), {
  minLength: 0,
  maxLength: 5,
});

/**
 * NAMESPACE/NAMESPACE_DONE 用の Track Namespace Suffix arbitrary
 *
 * draft-ietf-moq-transport-22 Section 9.16 (NAMESPACE):
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
 * draft-ietf-moq-transport-22 Section 9.14:
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
 * draft-ietf-moq-transport-22 Section 9.16:
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
 * draft-ietf-moq-transport-22 Section 9.17:
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
 * draft-ietf-moq-transport-22 Section 9.15:
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
 * draft-ietf-moq-transport-22 Section 9.15:
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
 * draft-ietf-moq-transport-22 §9.15:
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
 * draft-ietf-moq-transport-22 Section 9.18:
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
 * draft-ietf-moq-transport-22 Section 9.18:
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
 * draft-ietf-moq-transport-22 §9.18:
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

/**
 * draft-ietf-moq-transport-22 Section 9.19 (PUBLISH_SKIPPED):
 * PUBLISH_SKIPPED のエンコード・デコードがラウンドトリップすることを検証する。
 * コードポイント 0x0f は不変。
 */
test("PublishSkipped のエンコード・デコードがラウンドトリップする", () => {
  fc.assert(
    fc.property(
      fc.array(fc.string({ minLength: 1, maxLength: 20 }), { minLength: 0, maxLength: 5 }),
      fc.uint8Array({ minLength: 1, maxLength: 50 }),
      (namespaceParts, trackName) => {
        const original: PublishSkipped = {
          type: MessageType.PUBLISH_SKIPPED,
          trackNamespaceSuffix: createTrackNamespace(namespaceParts),
          trackName,
        };

        const encoded = encodePublishSkippedPayload(original);
        const decoded = decodePublishSkippedPayload(encoded);

        assert.equal(decoded.type, MessageType.PUBLISH_SKIPPED);
        assert.deepEqual(trackNamespaceToStrings(decoded.trackNamespaceSuffix), namespaceParts);
        assert.deepEqual(decoded.trackName, trackName);
      },
    ),
  );
});
