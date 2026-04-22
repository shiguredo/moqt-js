/**
 * MOQT AUTHORIZATION_TOKEN Property-Based Tests
 * draft-ietf-moq-transport-17 Section 9.3.2
 */

import * as fc from "fast-check";
import { assert, test } from "vite-plus/test";
import {
  type AuthorizationToken,
  decodeAuthorizationToken,
  encodeAuthorizationToken,
} from "./authorizationToken";

const aliasArb = fc.bigInt({ min: 0n, max: 2n ** 62n - 1n });
const tokenTypeArb = fc.bigInt({ min: 0n, max: 2n ** 62n - 1n });
const tokenValueArb = fc.uint8Array({ maxLength: 256 });

const tokenArb: fc.Arbitrary<AuthorizationToken> = fc.oneof(
  aliasArb.map((alias): AuthorizationToken => ({ kind: "delete", alias })),
  fc
    .record({ alias: aliasArb, tokenType: tokenTypeArb, tokenValue: tokenValueArb })
    .map((r): AuthorizationToken => ({ kind: "register", ...r })),
  aliasArb.map((alias): AuthorizationToken => ({ kind: "useAlias", alias })),
  fc
    .record({ tokenType: tokenTypeArb, tokenValue: tokenValueArb })
    .map((r): AuthorizationToken => ({ kind: "useValue", ...r })),
);

function equalToken(a: AuthorizationToken, b: AuthorizationToken): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "delete":
      return b.kind === "delete" && a.alias === b.alias;
    case "useAlias":
      return b.kind === "useAlias" && a.alias === b.alias;
    case "register":
      return (
        b.kind === "register" &&
        a.alias === b.alias &&
        a.tokenType === b.tokenType &&
        bytesEqual(a.tokenValue, b.tokenValue)
      );
    case "useValue":
      return (
        b.kind === "useValue" &&
        a.tokenType === b.tokenType &&
        bytesEqual(a.tokenValue, b.tokenValue)
      );
  }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

test("AuthorizationToken の encode/decode round-trip", () => {
  fc.assert(
    fc.property(tokenArb, (token) => {
      const decoded = decodeAuthorizationToken(encodeAuthorizationToken(token));
      assert.ok(equalToken(token, decoded));
    }),
  );
});

test("decodeAuthorizationToken は入力の Uint8Array を共有しない", () => {
  fc.assert(
    fc.property(aliasArb, tokenTypeArb, tokenValueArb, (alias, tokenType, value) => {
      const encoded = encodeAuthorizationToken({
        kind: "register",
        alias,
        tokenType,
        tokenValue: value,
      });
      const decoded = decodeAuthorizationToken(encoded);
      assert.equal(decoded.kind, "register");
      if (decoded.kind === "register") {
        // encoded バッファを汚しても decoded.tokenValue が変わらないこと
        encoded.fill(0);
        return bytesEqual(decoded.tokenValue, value);
      }
      return false;
    }),
  );
});
