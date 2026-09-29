/**
 * base64url (RFC 4648 Section 5) と標準 Base64 (Section 4) のテスト
 *
 * RFC 4648 Section 10 のテストベクタと、CAT トークンの URL 埋め込み
 * (draft-ietf-moq-c4m-01 Section 2 / Section 4) で必要になる表現の差を固定する。
 */

import { test, assert } from "vite-plus/test";
import {
  decodeBase64OrUrl,
  decodeBase64Url,
  encodeBase64Url,
  tryDecodeBase64OrUrl,
} from "./base64url";
import { assertBase64Error, encodeBase64Standard } from "./testSupport";

test("RFC 4648 Section 10 のベクタをエンコードできる", () => {
  const vectors: Array<[string, string]> = [
    ["", ""],
    ["f", "Zg"],
    ["fo", "Zm8"],
    ["foo", "Zm9v"],
    ["foob", "Zm9vYg"],
    ["fooba", "Zm9vYmE"],
    ["foobar", "Zm9vYmFy"],
  ];
  for (const [plain, encoded] of vectors) {
    const bytes = new TextEncoder().encode(plain);
    assert.equal(encodeBase64Url(bytes), encoded, `エンコード: ${plain}`);
    assert.deepEqual(decodeBase64Url(encoded), bytes, `デコード: ${encoded}`);
  }
});

test("base64url のアルファベット (62 / 63 文字目) を扱える", () => {
  // 0xfb 0xff は URL 用アルファベットで "-_" になる (標準では "+/")
  const bytes = new Uint8Array([0xfb, 0xff]);
  assert.equal(encodeBase64Url(bytes), "-_8");
  assert.deepEqual(decodeBase64Url("-_8"), bytes);
  // 標準アルファベットは decodeBase64OrUrl だけが受け付ける
  assert.deepEqual(decodeBase64OrUrl("+/8"), bytes);
});

test("パディング付きの base64url もデコードできる", () => {
  // JWK (RFC 7517) はパディング無しが仕様だが、パディング付きの入力も受理する
  assert.deepEqual(decodeBase64Url("Zm9v"), new TextEncoder().encode("foo"));
  assert.deepEqual(decodeBase64Url("Zm8="), new TextEncoder().encode("fo"));
  assert.deepEqual(decodeBase64Url("Zg=="), new TextEncoder().encode("f"));
});

test("標準 Base64 (パディングあり / なし) もデコードできる", () => {
  // draft-ietf-moq-c4m-01 Section 2 / Section 4: URL への埋め込みは標準 Base64
  const bytes = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04]);
  assert.deepEqual(decodeBase64OrUrl(encodeBase64Standard(bytes, true)), bytes);
  assert.deepEqual(decodeBase64OrUrl(encodeBase64Standard(bytes, false)), bytes);
  assert.deepEqual(decodeBase64OrUrl(encodeBase64Url(bytes)), bytes);
});

test("不正な base64url を拒否する", () => {
  // アルファベットに無い文字
  assertBase64Error(() => decodeBase64Url("****"));
  // 長さが 4 で割って 1 余る
  assertBase64Error(() => decodeBase64Url("Z"));
  // パディングが 3 文字以上
  assertBase64Error(() => decodeBase64Url("Z==="));
  // パディングの位置が不正 (長さが 4 の倍数にならない)
  assertBase64Error(() => decodeBase64Url("Zg="));
  // 端数ビットが 0 でない非正規なエンコード (RFC 4648 Section 3.5)
  assertBase64Error(() => decodeBase64Url("Zh"));
  assertBase64Error(() => decodeBase64Url("Zm9"));
});

test("tryDecodeBase64OrUrl は失敗を undefined で返す", () => {
  assert.equal(tryDecodeBase64OrUrl("###"), undefined);
  assert.deepEqual(tryDecodeBase64OrUrl("Zm9v"), new TextEncoder().encode("foo"));
});
