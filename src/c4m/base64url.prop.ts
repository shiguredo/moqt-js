/**
 * base64url (RFC 4648 Section 5) と標準 Base64 (Section 4) の Property-Based Testing
 *
 * エンコード結果の正規形 (canonical 性)、3 つのデコード API の整合、余るビットの
 * 拒否 (Section 3.5) を任意の入力で確認する。
 */

import { test, assert } from "vite-plus/test";
import * as fc from "fast-check";
import {
  Base64DecodeError,
  decodeBase64OrUrl,
  decodeBase64Url,
  encodeBase64Url,
  tryDecodeBase64OrUrl,
} from "./base64url";
import { assertBase64Error, encodeBase64Standard } from "./testSupport";

/** base64url のアルファベット (RFC 4648 Section 5) */
const BASE64_URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** 長い入力を含めるためのバイト列 (fast-check の既定 size は maxLength を 10 に切る) */
const bytesArbitrary = fc.uint8Array({ maxLength: 64, size: "max" });

/** 任意の文字列 (アルファベット外の文字、パディング、サロゲートを含み得る) */
const textArbitrary = fc.oneof(
  fc.string({ unit: "binary", maxLength: 32, size: "max" }),
  fc.stringMatching(/^[A-Za-z0-9+/=_-]{0,32}$/),
);

/**
 * 正規形の最後の文字の最下位ビットを反転する
 *
 * 最後の文字が持つ「余るビット」を 0 でなくするために使う。
 */
function flipLastCharacterLowestBit(text: string): string {
  const last = text.charAt(text.length - 1);
  const value = BASE64_URL_ALPHABET.indexOf(last);
  return text.slice(0, -1) + BASE64_URL_ALPHABET.charAt(value ^ 1);
}

test("エンコード結果は正規形 (パディング無し・base64url のアルファベットのみ) になる", () => {
  fc.assert(
    fc.property(bytesArbitrary, (bytes) => {
      const encoded = encodeBase64Url(bytes);
      assert.match(encoded, /^[A-Za-z0-9_-]*$/);
      assert.notInclude(encoded, "=");
      // パディング無しの長さは 4/3 バイトあたり 1 文字になる
      assert.equal(encoded.length, Math.ceil((bytes.length * 4) / 3));
      assert.deepEqual(decodeBase64Url(encoded), bytes);
    }),
  );
});

test("base64url のエンコードとデコードは往復する", () => {
  fc.assert(
    fc.property(bytesArbitrary, (bytes) => {
      const encoded = encodeBase64Url(bytes);
      assert.deepEqual(decodeBase64Url(encoded), bytes);
      assert.deepEqual(decodeBase64OrUrl(encoded), bytes);
    }),
  );
});

test("パディング付きの base64url もデコードできる", () => {
  fc.assert(
    fc.property(bytesArbitrary, (bytes) => {
      const encoded = encodeBase64Url(bytes);
      const padded = encoded + "=".repeat((4 - (encoded.length % 4)) % 4);
      assert.deepEqual(decodeBase64Url(padded), bytes);
      assert.deepEqual(decodeBase64OrUrl(padded), bytes);
    }),
  );
});

test("標準 Base64 (パディングあり / なし) もデコードできる", () => {
  fc.assert(
    fc.property(bytesArbitrary, (bytes) => {
      assert.deepEqual(decodeBase64OrUrl(encodeBase64Standard(bytes, true)), bytes);
      assert.deepEqual(decodeBase64OrUrl(encodeBase64Standard(bytes, false)), bytes);
    }),
  );
});

test("標準アルファベットを使う文字列は base64url としては拒否され、自動判別では受理される", () => {
  // 先頭に 62 / 63 の 6 ビット群を作るバイト列を置き、必ず `+` か `/` を含ませる
  const prefix = new Uint8Array([0xfb, 0xff]);
  fc.assert(
    fc.property(fc.uint8Array({ maxLength: 16, size: "max" }), (suffix) => {
      const bytes = new Uint8Array(prefix.length + suffix.length);
      bytes.set(prefix);
      bytes.set(suffix, prefix.length);
      const standard = encodeBase64Standard(bytes, false);
      assert.match(standard, /[+/]/);
      assertBase64Error(() => decodeBase64Url(standard));
      assert.deepEqual(decodeBase64OrUrl(standard), bytes);
    }),
  );
});

test("任意の文字列で例外は Base64DecodeError だけであり、3 つのデコード API が整合する", () => {
  fc.assert(
    fc.property(textArbitrary, (text) => {
      // 他の例外 (TypeError など) が漏れない
      let decoded: Uint8Array | undefined;
      try {
        decoded = decodeBase64OrUrl(text);
      } catch (error) {
        assert.ok(
          error instanceof Base64DecodeError,
          `Base64DecodeError を期待したが ${String(error)} が送出された`,
        );
      }
      // 失敗を値で扱う API は、成功時は同じバイト列、失敗時は undefined を返す
      assert.deepEqual(tryDecodeBase64OrUrl(text), decoded);

      // 厳密な base64url で成功するなら、自動判別でも同じバイト列になる
      let strict: Uint8Array | undefined;
      try {
        strict = decodeBase64Url(text);
      } catch (error) {
        assert.ok(error instanceof Base64DecodeError);
      }
      if (strict !== undefined) {
        assert.deepEqual(decoded, strict);
      }
    }),
  );
});

test("余るビットが 0 でない入力は非正規なエンコードとして拒否する", () => {
  // RFC 4648 Section 3.5: パディング無しの表現で余るビットは 0 でなければならない
  fc.assert(
    fc.property(bytesArbitrary, (bytes) => {
      const encoded = encodeBase64Url(bytes);
      // 余るビットが無い (4 の倍数) と反転するビットが無い
      if (encoded.length === 0 || encoded.length % 4 === 0) {
        return;
      }
      const mutated = flipLastCharacterLowestBit(encoded);
      assertBase64Error(() => decodeBase64Url(mutated));
      assertBase64Error(() => decodeBase64OrUrl(mutated));
    }),
  );
});

test("デコードしたバイト列の再エンコードは同じ文字列になる", () => {
  fc.assert(
    fc.property(bytesArbitrary, (bytes) => {
      const encoded = encodeBase64Url(bytes);
      assert.equal(encodeBase64Url(decodeBase64OrUrl(encoded)), encoded);
    }),
  );
});
