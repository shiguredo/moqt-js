/**
 * normalizeMoqtUri のテスト
 * draft-ietf-moq-transport-18 §3.1.1 / §3.1.2 / §3.1.3
 */

import { assert, test } from "vite-plus/test";
import { normalizeMoqtUri } from "./moqtUri";

test("moqt:// は https:// に変換される", () => {
  assert.equal(normalizeMoqtUri("moqt://example.com/moqt"), "https://example.com/moqt");
});

test("moqt:// + クエリ文字列はそのまま保持される", () => {
  assert.equal(
    normalizeMoqtUri("moqt://example.com/moqt?foo=bar&baz=qux"),
    "https://example.com/moqt?foo=bar&baz=qux",
  );
});

test("moqt:// + ポート番号は保持される", () => {
  assert.equal(normalizeMoqtUri("moqt://127.0.0.1:4443/moqt"), "https://127.0.0.1:4443/moqt");
});

test("moqt:// + /.well-known/moqt パスは保持される", () => {
  assert.equal(
    normalizeMoqtUri("moqt://example.com/.well-known/moqt"),
    "https://example.com/.well-known/moqt",
  );
});

test("moqt:// の fragment は除去される", () => {
  assert.equal(normalizeMoqtUri("moqt://example.com/moqt#track:video"), "https://example.com/moqt");
});

test("moqt:// + クエリ + fragment は fragment のみ除去される", () => {
  assert.equal(
    normalizeMoqtUri("moqt://example.com/moqt?foo=bar#track:video"),
    "https://example.com/moqt?foo=bar",
  );
});

test("空文字列は Error になる", () => {
  assert.throws(() => normalizeMoqtUri(""), Error, /url is empty/);
});

test("https:// は Error になる", () => {
  assert.throws(
    () => normalizeMoqtUri("https://example.com/moqt"),
    Error,
    /must start with moqt:\/\//,
  );
});

test("moqt:// 以外のスキームは Error になる", () => {
  assert.throws(
    () => normalizeMoqtUri("ftp://example.com/moqt"),
    Error,
    /must start with moqt:\/\//,
  );
});

test("http:// (TLS なし) は Error になる", () => {
  assert.throws(
    () => normalizeMoqtUri("http://example.com/moqt"),
    Error,
    /must start with moqt:\/\//,
  );
});

test("authority の host が空の moqt:// は Error になる", () => {
  assert.throws(() => normalizeMoqtUri("moqt:///path"), Error, /empty host/);
});

test("moqt:// だけ (host なし) は Error になる", () => {
  assert.throws(() => normalizeMoqtUri("moqt://"), Error, /empty host/);
});
