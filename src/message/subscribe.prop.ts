/**
 * MOQT Subscribe Messages Property-Based Tests
 * draft-ietf-moq-transport-22 Section 9.5-9.7
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
 * draft-ietf-moq-transport-22:
 * SUBSCRIBE_OK に Track Properties が追加された。
 * draft-ietf-moq-transport-22 Section 9 (Control Messages)
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
 * draft-ietf-moq-transport-22 Section 9.5:
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
