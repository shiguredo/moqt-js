/**
 * base64url (RFC 4648 Section 5) と標準 Base64 (Section 4) の Property-Based Testing
 */

import { test, assert } from "vite-plus/test";
import * as fc from "fast-check";
import { decodeBase64OrUrl, decodeBase64Url, encodeBase64Url } from "./base64url";
import { encodeBase64Standard } from "./testSupport";

test("base64url のエンコードとデコードは往復する", () => {
  fc.assert(
    fc.property(fc.uint8Array({ maxLength: 64 }), (bytes) => {
      const encoded = encodeBase64Url(bytes);
      assert.deepEqual(decodeBase64Url(encoded), bytes);
      assert.deepEqual(decodeBase64OrUrl(encoded), bytes);
    }),
  );
});

test("パディング付きの base64url もデコードできる", () => {
  fc.assert(
    fc.property(fc.uint8Array({ maxLength: 64 }), (bytes) => {
      const encoded = encodeBase64Url(bytes);
      const padded = encoded + "=".repeat((4 - (encoded.length % 4)) % 4);
      assert.deepEqual(decodeBase64Url(padded), bytes);
    }),
  );
});

test("標準 Base64 (パディングあり / なし) もデコードできる", () => {
  fc.assert(
    fc.property(fc.uint8Array({ maxLength: 64 }), (bytes) => {
      assert.deepEqual(decodeBase64OrUrl(encodeBase64Standard(bytes, true)), bytes);
      assert.deepEqual(decodeBase64OrUrl(encodeBase64Standard(bytes, false)), bytes);
    }),
  );
});

test("デコードしたバイト列の再エンコードは同じ文字列になる", () => {
  fc.assert(
    fc.property(fc.uint8Array({ maxLength: 64 }), (bytes) => {
      const encoded = encodeBase64Url(bytes);
      assert.equal(encodeBase64Url(decodeBase64OrUrl(encoded)), encoded);
    }),
  );
});
