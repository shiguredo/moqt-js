/**
 * MOQT Fetch Messages Property-Based Tests
 * draft-ietf-moq-transport-21 Section 9.11-9.12
 */

import { test, assert } from "vite-plus/test";
import * as fc from "fast-check";
import {
  type Fetch,
  type FetchOk,
  decodeFetchOkPayload,
  decodeFetchPayload,
  encodeFetchOkPayload,
  encodeFetchPayload,
} from "./fetch";
import { trackNamespaceToStrings } from "./parameter";
import { MessageType } from "./types";
import { ProtocolViolationError } from "../error";
import { parametersArb, trackPropertiesArb, namespaceArb, trackNameArb } from "./parameterArb";

/**
 * draft-ietf-moq-transport-21 Section 2.3:
 * ゼロ要素 (空) のネームスペースを許可する。
 * draft-ietf-moq-transport-21 Section 9 (Control Messages)
 */
const locationArb = fc.record({
  group: fc.bigInt({ min: 0n, max: 1000000n }),
  object: fc.bigInt({ min: 0n, max: 1000000n }),
});

test("Fetch のエンコード・デコードがラウンドトリップする", () => {
  fc.assert(
    fc.property(
      fc.bigInt({ min: 0n, max: 1000000n }),
      namespaceArb,
      trackNameArb,
      parametersArb,
      (requestId, trackNamespace, trackName, parameters) => {
        const original: Fetch = {
          type: MessageType.FETCH,
          requestId,
          trackNamespace,
          trackName,
          parameters,
        };

        const encoded = encodeFetchPayload(original);
        const decoded = decodeFetchPayload(encoded);

        assert.equal(decoded.type, MessageType.FETCH);
        assert.equal(decoded.requestId, requestId);
        assert.deepEqual(
          trackNamespaceToStrings(decoded.trackNamespace),
          trackNamespaceToStrings(trackNamespace),
        );
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
 * draft-ietf-moq-transport-21 Section 9:
 * "If the length does not match the length of the Message Body,
 *  the receiver MUST close the session with a PROTOCOL_VIOLATION."
 * Parameters は FETCH ペイロードの最後のフィールドであり、
 * その後ろに後続データがあると消費バイト数が Message Body 長と一致しないため違反となる。
 * 正常な FETCH の後ろに後続バイト列を連結すると
 * ProtocolViolationError を throw することを検証する。
 */
test("FETCH の末尾に後続データがあると ProtocolViolationError を throw する", () => {
  fc.assert(
    fc.property(
      fc.bigInt({ min: 0n, max: 1000000n }),
      namespaceArb,
      trackNameArb,
      parametersArb,
      fc.uint8Array({ minLength: 1, maxLength: 1000 }),
      (requestId, trackNamespace, trackName, parameters, trailing) => {
        const original: Fetch = {
          type: MessageType.FETCH,
          requestId,
          trackNamespace,
          trackName,
          parameters,
        };

        const encoded = encodeFetchPayload(original);
        // 正常な FETCH の後ろに 1 バイト以上の後続データを連結する
        const withTrailing = new Uint8Array(encoded.length + trailing.length);
        withTrailing.set(encoded, 0);
        withTrailing.set(trailing, encoded.length);

        assert.throws(() => decodeFetchPayload(withTrailing), ProtocolViolationError);
      },
    ),
  );
});

/**
 * draft-ietf-moq-transport-21:
 * FETCH_OK に Track Properties が追加された。
 */
test("FetchOk のエンコード・デコードがラウンドトリップする", () => {
  fc.assert(
    fc.property(
      fc.boolean(),
      locationArb,
      parametersArb,
      trackPropertiesArb,
      (endOfTrack, endLocation, parameters, trackProperties) => {
        const original: FetchOk = {
          type: MessageType.FETCH_OK,
          endOfTrack,
          endLocation,
          parameters,
          trackProperties,
        };

        const encoded = encodeFetchOkPayload(original);
        const decoded = decodeFetchOkPayload(encoded);

        assert.equal(decoded.type, MessageType.FETCH_OK);
        assert.equal(decoded.endOfTrack, endOfTrack);
        assert.equal(decoded.endLocation.group, endLocation.group);
        assert.equal(decoded.endLocation.object, endLocation.object);
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
