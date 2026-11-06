/**
 * MOQT Fetch Messages Property-Based Tests
 * draft-ietf-moq-transport-23 §9.11 (FETCH)
 *
 * FETCH の成功応答は REQUEST_OK (§9.3) に統合されたため、FETCH 要求の
 * エンコード・デコードだけを検証する。REQUEST_OK の round-trip は
 * src/message/session.prop.ts が担う。
 */

import { test, assert } from "vite-plus/test";
import * as fc from "fast-check";
import { type Fetch, decodeFetchPayload, encodeFetchPayload } from "./fetch";
import { trackNamespaceToStrings } from "./parameter";
import { MessageType } from "./types";
import { parametersArb, namespaceArb, trackNameArb } from "./parameterArb";

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
