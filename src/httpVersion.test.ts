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

// セッション未確立は "--" (未確立) と表示する
test("pending と空文字は -- に変換される", () => {
  assert.equal(toHttpVersionLabel("pending"), "--");
  assert.equal(toHttpVersionLabel(""), "--");
});

// プロパティが存在しない場合は undefined として渡されるため、これも未確立として扱う
test("undefined は -- に変換される", () => {
  assert.equal(toHttpVersionLabel(undefined), "--");
});

// reliability が使えない場合 (プロパティ未実装の "N/A" や未知の値) は、
// 未確立の "--" と区別して "N/A" (判定不能) にする
test("N/A と未知の値は N/A に変換される", () => {
  assert.equal(toHttpVersionLabel("N/A"), "N/A");
  assert.equal(toHttpVersionLabel("unknown-value"), "N/A");
});
