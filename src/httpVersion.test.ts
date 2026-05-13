/**
 * toHttpVersionLabel のテスト
 * W3C WebTransport: https://www.w3.org/TR/webtransport/#dom-webtransport-reliability
 */

import { assert, test } from "vite-plus/test";
import { toHttpVersionLabel } from "./httpVersion";

test("supports-unreliable は HTTP/3 に変換される", () => {
  assert.equal(toHttpVersionLabel("supports-unreliable"), "HTTP/3");
});

test("reliable-only は HTTP/2 に変換される", () => {
  assert.equal(toHttpVersionLabel("reliable-only"), "HTTP/2");
});

test("pending は -- に変換される", () => {
  assert.equal(toHttpVersionLabel("pending"), "--");
});

test("undefined は -- に変換される", () => {
  assert.equal(toHttpVersionLabel(undefined), "--");
});

test("未知の文字列は -- に変換される", () => {
  assert.equal(toHttpVersionLabel("unknown-value"), "--");
});
