/**
 * MOQT TrackStatus Messages Property-Based Tests
 * draft-ietf-moq-transport-16 Section 9.19
 */

import { test, assert } from "vitest";
import * as fc from "fast-check";
import {
  type TrackStatus,
  decodeTrackStatusPayload,
  encodeTrackStatusPayload,
} from "./trackstatus";
import { createTrackNamespace, trackNamespaceToStrings, type Parameter } from "./parameter";
import { MessageType } from "./types";
import { encodeVarint } from "../varint";

const namespaceStringsArb = fc.array(fc.string({ minLength: 1, maxLength: 20 }), {
  minLength: 1,
  maxLength: 5,
});

const trackNameArb = fc
  .string({ minLength: 1, maxLength: 50 })
  .map((s) => new TextEncoder().encode(s));

const evenParameterArb = fc
  .record({
    type: fc.integer({ min: 0, max: 100 }).map((n) => n * 2),
    varintValue: fc.bigInt({ min: 0n, max: 1000000n }),
  })
  .map(({ type, varintValue }) => ({ type, value: encodeVarint(varintValue) }));

const oddParameterArb = fc.record({
  type: fc.integer({ min: 0, max: 100 }).map((n) => n * 2 + 1),
  value: fc.uint8Array({ minLength: 0, maxLength: 20 }),
});

const parameterArb: fc.Arbitrary<Parameter> = fc.oneof(evenParameterArb, oddParameterArb);

const parametersArb = fc.array(parameterArb, { minLength: 0, maxLength: 3 });

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
