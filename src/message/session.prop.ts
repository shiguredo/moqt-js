/**
 * MOQT Session Messages Property-Based Tests
 * draft-ietf-moq-transport-15 Section 9.2-9.6
 */

import { test, assert } from "vitest";
import * as fc from "fast-check";
import {
  type Goaway,
  type MaxRequestId,
  type RequestError,
  type RequestOk,
  type RequestsBlocked,
  decodeGoawayPayload,
  decodeMaxRequestIdPayload,
  decodeRequestErrorPayload,
  decodeRequestOkPayload,
  decodeRequestsBlockedPayload,
  encodeGoawayPayload,
  encodeMaxRequestIdPayload,
  encodeRequestErrorPayload,
  encodeRequestOkPayload,
  encodeRequestsBlockedPayload,
} from "./session";
import { type Parameter } from "./parameter";
import { MessageType } from "./types";
import { encodeVarint } from "../varint";

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

test("Goaway のエンコード・デコードがラウンドトリップする", () => {
  fc.assert(
    fc.property(fc.string({ minLength: 0, maxLength: 200 }), (newSessionUri) => {
      const original: Goaway = {
        type: MessageType.GOAWAY,
        newSessionUri,
      };

      const encoded = encodeGoawayPayload(original);
      const decoded = decodeGoawayPayload(encoded);

      assert.equal(decoded.type, MessageType.GOAWAY);
      assert.equal(decoded.newSessionUri, newSessionUri);
    }),
  );
});

test("MaxRequestId のエンコード・デコードがラウンドトリップする", () => {
  fc.assert(
    fc.property(fc.bigInt({ min: 0n, max: 0xffffffffn }), (maxRequestId) => {
      const original: MaxRequestId = {
        type: MessageType.MAX_REQUEST_ID,
        maxRequestId,
      };

      const encoded = encodeMaxRequestIdPayload(original);
      const decoded = decodeMaxRequestIdPayload(encoded);

      assert.equal(decoded.type, MessageType.MAX_REQUEST_ID);
      assert.equal(decoded.maxRequestId, maxRequestId);
    }),
  );
});

test("RequestsBlocked のエンコード・デコードがラウンドトリップする", () => {
  fc.assert(
    fc.property(fc.bigInt({ min: 0n, max: 1000000n }), (maximumRequestId) => {
      const original: RequestsBlocked = {
        type: MessageType.REQUESTS_BLOCKED,
        maximumRequestId,
      };

      const encoded = encodeRequestsBlockedPayload(original);
      const decoded = decodeRequestsBlockedPayload(encoded);

      assert.equal(decoded.type, MessageType.REQUESTS_BLOCKED);
      assert.equal(decoded.maximumRequestId, maximumRequestId);
    }),
  );
});

test("RequestOk のエンコード・デコードがラウンドトリップする", () => {
  fc.assert(
    fc.property(fc.bigInt({ min: 0n, max: 1000000n }), parametersArb, (requestId, parameters) => {
      const original: RequestOk = {
        type: MessageType.REQUEST_OK,
        requestId,
        parameters,
      };

      const encoded = encodeRequestOkPayload(original);
      const decoded = decodeRequestOkPayload(encoded);

      assert.equal(decoded.type, MessageType.REQUEST_OK);
      assert.equal(decoded.requestId, requestId);
      assert.equal(decoded.parameters.length, parameters.length);
      for (let i = 0; i < parameters.length; i++) {
        assert.equal(decoded.parameters[i].type, parameters[i].type);
        assert.deepEqual(decoded.parameters[i].value, parameters[i].value);
      }
    }),
  );
});

test("RequestError のエンコード・デコードがラウンドトリップする", () => {
  fc.assert(
    fc.property(
      fc.bigInt({ min: 0n, max: 1000000n }),
      fc.bigInt({ min: 0n, max: 1000n }),
      fc.string({ minLength: 0, maxLength: 200 }),
      (requestId, errorCode, reasonPhrase) => {
        const original: RequestError = {
          type: MessageType.REQUEST_ERROR,
          requestId,
          errorCode,
          reasonPhrase,
        };

        const encoded = encodeRequestErrorPayload(original);
        const decoded = decodeRequestErrorPayload(encoded);

        assert.equal(decoded.type, MessageType.REQUEST_ERROR);
        assert.equal(decoded.requestId, requestId);
        assert.equal(decoded.errorCode, errorCode);
        assert.equal(decoded.reasonPhrase, reasonPhrase);
      },
    ),
  );
});
