/**
 * MOQT Setup Messages Property-Based Tests
 * draft-ietf-moq-transport-17 Section 9.4
 */

import { test, assert } from "vite-plus/test";
import * as fc from "fast-check";
import {
  createSetup,
  encodeSetupPayload,
  decodeSetupPayload,
  getSetupPath,
  getSetupAuthority,
} from "./setup";
import { MessageType } from "./types";

test("Setup のエンコード・デコードがラウンドトリップする", () => {
  fc.assert(
    fc.property(
      fc.option(fc.string({ minLength: 1, maxLength: 100 }), { nil: undefined }),
      fc.option(fc.string({ minLength: 1, maxLength: 100 }), { nil: undefined }),
      (path, authority) => {
        const original = createSetup({ path, authority });
        const encoded = encodeSetupPayload(original);
        const decoded = decodeSetupPayload(encoded);

        assert.equal(decoded.type, MessageType.SETUP);
        assert.equal(getSetupPath(decoded), path);
        assert.equal(getSetupAuthority(decoded), authority);
      },
    ),
  );
});
