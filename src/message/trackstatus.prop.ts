/**
 * MOQT TrackStatus Messages Property-Based Tests
 * draft-ietf-moq-transport-22 Section 9.13
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
