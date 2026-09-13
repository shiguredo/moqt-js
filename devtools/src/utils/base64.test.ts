import { test, assert } from "vite-plus/test";
import { base64ToArrayBuffer } from "./base64";

// 証明書ハッシュは 32 バイトの SHA-256 を Base64 で受け取る。
test("base64ToArrayBuffer converts a base64 string to bytes", () => {
  const hash = new Uint8Array(32).map((_, index) => index);
  const base64 = btoa(String.fromCharCode(...hash));

  assert.deepEqual(new Uint8Array(base64ToArrayBuffer(base64)), hash);
});

// 空文字はエラーにせず長さ 0 の ArrayBuffer を返す。
test("base64ToArrayBuffer returns an empty buffer for an empty string", () => {
  assert.equal(base64ToArrayBuffer("").byteLength, 0);
});

// パディング付きの Base64 でも末尾バイトまで復元できることを確認する。
test("base64ToArrayBuffer decodes padded base64", () => {
  const bytes = new Uint8Array([0x00, 0xff, 0x10]);

  assert.deepEqual(new Uint8Array(base64ToArrayBuffer("AP8Q")), bytes);
});

// 不正な Base64 は握り潰さず例外にする。
// 設定欄の打ち間違いを黙って通すと接続失敗の原因が分からなくなるため。
test("base64ToArrayBuffer throws on an invalid base64 string", () => {
  assert.throws(() => base64ToArrayBuffer("not base64!!"));
});
