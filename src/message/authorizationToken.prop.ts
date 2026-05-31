/**
 * MOQT Authorization Token Property-Based Tests
 * draft-ietf-moq-transport-18 Section 10.2.2 (AUTHORIZATION TOKEN Parameter)
 */

import { test, assert } from "vite-plus/test";
import * as fc from "fast-check";
import {
  AuthorizationTokenAliasType,
  type AuthorizationToken,
  decodeAuthorizationToken,
  encodeAuthorizationToken,
} from "./authorizationToken";

// varint は 62bit まで表現可能なので、フィールドは 2^53-1 で打ち切り
const MAX_VARINT = BigInt(Number.MAX_SAFE_INTEGER);

const tokenAliasArb = fc.bigInt({ min: 0n, max: MAX_VARINT });
const tokenTypeArb = fc.bigInt({ min: 0n, max: MAX_VARINT });
const tokenValueArb = fc.uint8Array({ maxLength: 256 }).map((arr) => new Uint8Array(arr));

test("AuthorizationToken: USE_VALUE roundtrip (PBT)", () => {
  fc.assert(
    fc.property(tokenTypeArb, tokenValueArb, (tokenType, tokenValue) => {
      const original: AuthorizationToken = {
        aliasType: AuthorizationTokenAliasType.USE_VALUE,
        tokenType,
        tokenValue,
      };
      const decoded = decodeAuthorizationToken(encodeAuthorizationToken(original));
      assert.equal(decoded.aliasType, AuthorizationTokenAliasType.USE_VALUE);
      if (decoded.aliasType === AuthorizationTokenAliasType.USE_VALUE) {
        assert.equal(decoded.tokenType, tokenType);
        assert.deepEqual(Array.from(decoded.tokenValue), Array.from(tokenValue));
      }
    }),
  );
});

test("AuthorizationToken: REGISTER roundtrip (PBT)", () => {
  fc.assert(
    fc.property(tokenAliasArb, tokenTypeArb, tokenValueArb, (tokenAlias, tokenType, tokenValue) => {
      const original: AuthorizationToken = {
        aliasType: AuthorizationTokenAliasType.REGISTER,
        tokenAlias,
        tokenType,
        tokenValue,
      };
      const decoded = decodeAuthorizationToken(encodeAuthorizationToken(original));
      assert.equal(decoded.aliasType, AuthorizationTokenAliasType.REGISTER);
      if (decoded.aliasType === AuthorizationTokenAliasType.REGISTER) {
        assert.equal(decoded.tokenAlias, tokenAlias);
        assert.equal(decoded.tokenType, tokenType);
        assert.deepEqual(Array.from(decoded.tokenValue), Array.from(tokenValue));
      }
    }),
  );
});

test("AuthorizationToken: USE_ALIAS roundtrip (PBT)", () => {
  fc.assert(
    fc.property(tokenAliasArb, (tokenAlias) => {
      const original: AuthorizationToken = {
        aliasType: AuthorizationTokenAliasType.USE_ALIAS,
        tokenAlias,
      };
      const decoded = decodeAuthorizationToken(encodeAuthorizationToken(original));
      assert.equal(decoded.aliasType, AuthorizationTokenAliasType.USE_ALIAS);
      if (decoded.aliasType === AuthorizationTokenAliasType.USE_ALIAS) {
        assert.equal(decoded.tokenAlias, tokenAlias);
      }
    }),
  );
});

test("AuthorizationToken: DELETE roundtrip (PBT)", () => {
  fc.assert(
    fc.property(tokenAliasArb, (tokenAlias) => {
      const original: AuthorizationToken = {
        aliasType: AuthorizationTokenAliasType.DELETE,
        tokenAlias,
      };
      const decoded = decodeAuthorizationToken(encodeAuthorizationToken(original));
      assert.equal(decoded.aliasType, AuthorizationTokenAliasType.DELETE);
      if (decoded.aliasType === AuthorizationTokenAliasType.DELETE) {
        assert.equal(decoded.tokenAlias, tokenAlias);
      }
    }),
  );
});
