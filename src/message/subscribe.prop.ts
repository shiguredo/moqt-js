/**
 * MOQT Subscribe Messages Property-Based Tests
 * draft-ietf-moq-transport-21 Section 9.5-9.7
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
import { createTrackNamespace, trackNamespaceToStrings } from "./parameter";
import { MessageType } from "./types";
import { ProtocolViolationError } from "../error";
import {
  parametersArb,
  trackPropertiesArb,
  namespaceStringsArb,
  trackNameArb,
} from "./parameterArb";

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
 * draft-ietf-moq-transport-21:
 * SUBSCRIBE_OK に Track Properties が追加された。
 * draft-ietf-moq-transport-21 Section 9 (Control Messages)
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
 * draft-ietf-moq-transport-21 Section 9:
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
 * draft-ietf-moq-transport-21 Section 9.5:
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
 * draft-ietf-moq-transport-21 Section 9:
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
