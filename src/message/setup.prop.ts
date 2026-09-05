/**
 * MOQT Setup Messages Property-Based Tests
 * draft-ietf-moq-transport-20 Section 10.3
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

// draft-ietf-moq-transport-20 §10.3.1.1 / §10.3.1.2:
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

// draft-ietf-moq-transport-20 §13.8 (Implementation Identification Fingerprinting):
// moqtImplementation の 3 分岐（未指定 / false / 文字列）のラウンドトリップを検証する。
// 未指定は既定値、false は Option 欠落、文字列（空文字列・BMP 外文字を含む）はその値が復元される。
// fast-check v4 の fc.string() 既定は printable ASCII のみのため、unit: "grapheme" で
// 全 Unicode（サロゲートペアを含む）の UTF-8 ラウンドトリップを検証する。
test("Setup ラウンドトリップで moqtImplementation の 3 分岐が再現される", () => {
  fc.assert(
    fc.property(
      fc.oneof(
        fc.constant(undefined),
        fc.constant(false as const),
        fc.string({ unit: "grapheme" }),
      ),
      (moqtImplementation) => {
        const original = createSetup(
          moqtImplementation === undefined ? undefined : { moqtImplementation },
        );
        const encoded = encodeSetupPayload(original);
        const decoded = decodeSetupPayload(encoded);

        assert.equal(decoded.type, MessageType.SETUP);
        if (moqtImplementation === false) {
          // opt-out: MOQT_IMPLEMENTATION は欠落する
          assert.isUndefined(getSetupMoqtImplementation(decoded));
        } else if (typeof moqtImplementation === "string") {
          // override: 指定値（空文字列を含む）がそのまま復元される
          assert.equal(getSetupMoqtImplementation(decoded), moqtImplementation);
        } else {
          // 既定: MOQT_IMPLEMENTATION_VALUE が復元される
          assert.equal(getSetupMoqtImplementation(decoded), MOQT_IMPLEMENTATION_VALUE);
        }
      },
    ),
  );
});
