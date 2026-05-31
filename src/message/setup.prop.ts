/**
 * MOQT Setup Messages Property-Based Tests
 * draft-ietf-moq-transport-18 Section 10.3
 */

import { test, assert } from "vite-plus/test";
import * as fc from "fast-check";
import {
  createSetup,
  encodeSetupPayload,
  decodeSetupPayload,
  getSetupAuthorizationTokens,
  getSetupMoqtImplementation,
  getSetupPath,
  getSetupAuthority,
} from "./setup";
import { AuthorizationTokenAliasType, type AuthorizationToken } from "./authorizationToken";
import { MessageType } from "./types";
import { MOQT_IMPLEMENTATION_VALUE } from "../version";

// draft-ietf-moq-transport-18 §10.3.1.1 / §10.3.1.2:
// AUTHORITY (0x05) / PATH (0x01) は WebTransport 使用時には MUST NOT 送信。
// moqt-js は WebTransport 専用クライアントのため createSetup から PATH / AUTHORITY が
// 出てこないことを多数のラウンドトリップで保証する。
test("Setup ラウンドトリップで PATH / AUTHORITY は決して含まれない", () => {
  fc.assert(
    fc.property(
      fc.option(fc.uint8Array({ minLength: 1, maxLength: 100 }), { nil: undefined }),
      (tokenValue) => {
        let authorizationToken: AuthorizationToken | undefined;
        if (tokenValue !== undefined) {
          authorizationToken = {
            aliasType: AuthorizationTokenAliasType.USE_VALUE,
            tokenType: 0n,
            tokenValue,
          };
        }
        const original = createSetup(authorizationToken ? { authorizationToken } : undefined);
        const encoded = encodeSetupPayload(original);
        const decoded = decodeSetupPayload(encoded);

        assert.equal(decoded.type, MessageType.SETUP);
        assert.isUndefined(getSetupPath(decoded));
        assert.isUndefined(getSetupAuthority(decoded));
        assert.equal(getSetupMoqtImplementation(decoded), MOQT_IMPLEMENTATION_VALUE);
        if (authorizationToken !== undefined) {
          const tokens = getSetupAuthorizationTokens(decoded);
          assert.equal(tokens.length, 1);
        }
      },
    ),
  );
});
