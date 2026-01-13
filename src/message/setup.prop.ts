/**
 * MOQT Setup Messages Property-Based Tests
 * draft-ietf-moq-transport-16 Section 9.3
 */

import { test, assert } from "vitest";
import * as fc from "fast-check";
import {
  createClientSetup,
  createServerSetup,
  encodeClientSetupPayload,
  decodeClientSetupPayload,
  encodeServerSetupPayload,
  decodeServerSetupPayload,
  getSetupPath,
  getSetupMaxRequestId,
  getSetupAuthority,
} from "./setup";
import { MessageType } from "./types";

test("ClientSetup のエンコード・デコードがラウンドトリップする", () => {
  fc.assert(
    fc.property(
      fc.option(fc.string({ minLength: 1, maxLength: 100 }), { nil: undefined }),
      fc.option(fc.bigInt({ min: 0n, max: 1000000n }), { nil: undefined }),
      fc.option(fc.string({ minLength: 1, maxLength: 100 }), { nil: undefined }),
      (path, maxRequestId, authority) => {
        const original = createClientSetup({ path, maxRequestId, authority });
        const encoded = encodeClientSetupPayload(original);
        const decoded = decodeClientSetupPayload(encoded);

        assert.equal(decoded.type, MessageType.CLIENT_SETUP);
        assert.equal(getSetupPath(decoded), path);
        assert.equal(getSetupMaxRequestId(decoded), maxRequestId);
        assert.equal(getSetupAuthority(decoded), authority);
      },
    ),
  );
});

test("ServerSetup のエンコード・デコードがラウンドトリップする", () => {
  fc.assert(
    fc.property(
      fc.option(fc.bigInt({ min: 0n, max: 1000000n }), { nil: undefined }),
      (maxRequestId) => {
        const original = createServerSetup({ maxRequestId });
        const encoded = encodeServerSetupPayload(original);
        const decoded = decodeServerSetupPayload(encoded);

        assert.equal(decoded.type, MessageType.SERVER_SETUP);
        assert.equal(getSetupMaxRequestId(decoded), maxRequestId);
      },
    ),
  );
});
