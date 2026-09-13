/**
 * MOQT Publish Messages Property-Based Tests
 * draft-ietf-moq-transport-21 Section 9.8-9.9
 */

import { test, assert } from "vite-plus/test";
import * as fc from "fast-check";
import {
  encodePublishPayload,
  decodePublishPayload,
  encodePublishDonePayload,
  decodePublishDonePayload,
} from "./publish";
import { createTrackNamespace, trackNamespaceToStrings } from "./parameter";
import { MessageType } from "./types";
import { encodeVarint } from "../varint";
import { ProtocolViolationError } from "../error";
import { type Property } from "../properties";
import { decodeRequestOkPayload, encodeRequestOkPayload } from "./session";
import {
  parametersArb,
  trackPropertiesArb,
  namespaceStringsArb,
  trackNameArb,
} from "./parameterArb";

/**
 * draft-ietf-moq-transport-21:
 * PUBLISH に Track Properties が追加された。
 * draft-ietf-moq-transport-21 Section 9 (Control Messages)
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
 * draft-ietf-moq-transport-21 Section 9.9:
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
 * draft-ietf-moq-transport-21 Section 9:
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
 * draft-ietf-moq-transport-21 Section 8.5:
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
