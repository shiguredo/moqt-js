/**
 * MOQT TrackStatus Messages Property-Based Tests
 * draft-ietf-moq-transport-21 Section 9.13
 */

import { test, assert } from "vite-plus/test";
import * as fc from "fast-check";
import {
  type TrackStatus,
  decodeTrackStatusPayload,
  encodeTrackStatusPayload,
} from "./trackstatus";
import { createTrackNamespace, trackNamespaceToStrings } from "./parameter";
import { MessageType } from "./types";
import { ProtocolViolationError } from "../error";
import { parametersArb, namespaceStringsArb, trackNameArb } from "./parameterArb";

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
 * draft-ietf-moq-transport-21 Section 9:
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
