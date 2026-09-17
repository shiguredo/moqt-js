/**
 * normalizeMoqtUri / parseFragment のテスト
 * draft-ietf-moq-transport-21 §6.1 / §6.1.1 / §6.2.1
 */

import { assert, test } from "vite-plus/test";
import { normalizeMoqtUri, parseFragment } from "./moqtUri";

// ---- normalizeMoqtUri: URL 変換 ----

test("moqt:// は https:// に変換される (fragment なし)", () => {
  const result = normalizeMoqtUri("moqt://example.com/moqt");
  assert.equal(result.url, "https://example.com/moqt");
  assert.equal(result.fragment, null);
});

test("moqt:// + クエリ文字列はそのまま保持される", () => {
  const result = normalizeMoqtUri("moqt://example.com/moqt?foo=bar&baz=qux");
  assert.equal(result.url, "https://example.com/moqt?foo=bar&baz=qux");
  assert.equal(result.fragment, null);
});

test("moqt:// + ポート番号は保持される", () => {
  const result = normalizeMoqtUri("moqt://127.0.0.1:4443/moqt");
  assert.equal(result.url, "https://127.0.0.1:4443/moqt");
});

test("moqt:// + /.well-known/moqt パスは保持される", () => {
  const result = normalizeMoqtUri("moqt://example.com/.well-known/moqt");
  assert.equal(result.url, "https://example.com/.well-known/moqt");
});

// ---- normalizeMoqtUri: fragment ----

test("moqt:// + fragment は url 側から除去され fragment フィールドに格納される", () => {
  const result = normalizeMoqtUri("moqt://example.com/moqt#track:video");
  assert.equal(result.url, "https://example.com/moqt");
  assert.deepEqual(result.fragment, { type: "track", value: "video" });
});

test("moqt:// + クエリ + fragment は両方とも適切に処理される", () => {
  const result = normalizeMoqtUri("moqt://example.com/moqt?foo=bar#ns:room/123");
  assert.equal(result.url, "https://example.com/moqt?foo=bar");
  assert.deepEqual(result.fragment, { type: "ns", value: "room/123" });
});

test("value にコロンが含まれる fragment は最初のコロンで分割される", () => {
  const result = normalizeMoqtUri("moqt://example.com/moqt#type:val:ue");
  assert.deepEqual(result.fragment, { type: "type", value: "val:ue" });
});

test("コロンなしの fragment は Error になる", () => {
  assert.throws(
    () => normalizeMoqtUri("moqt://example.com/moqt#novalue"),
    Error,
    /fragment must contain a colon separator/,
  );
});

test("type が空の fragment は Error になる", () => {
  assert.throws(
    () => normalizeMoqtUri("moqt://example.com/moqt#:value"),
    Error,
    /fragment type identifier must not be empty/,
  );
});

test("type に大文字を含む fragment は Error になる", () => {
  assert.throws(
    () => normalizeMoqtUri("moqt://example.com/moqt#TYPE:value"),
    Error,
    /ASCII lowercase letters, digits, and hyphens/,
  );
});

// ---- normalizeMoqtUri: スキーム / host エラー ----

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

// ---- normalizeMoqtUri: IPv6 リテラル ----

test("IPv6 リテラル (ポート付き) はそのまま保持される", () => {
  const result = normalizeMoqtUri("moqt://[::1]:4443/moqt");
  assert.equal(result.url, "https://[::1]:4443/moqt");
  assert.equal(result.fragment, null);
});

test("IPv6 リテラル (ポートなし) はそのまま保持される", () => {
  const result = normalizeMoqtUri("moqt://[2001:db8::1]/moqt");
  assert.equal(result.url, "https://[2001:db8::1]/moqt");
});

test("IPv6 リテラル + クエリ + fragment は url 側から fragment のみ除去される", () => {
  const result = normalizeMoqtUri("moqt://[2001:db8::1]:4443/app?x=1#track:v");
  assert.equal(result.url, "https://[2001:db8::1]:4443/app?x=1");
  assert.deepEqual(result.fragment, { type: "track", value: "v" });
});

test("閉じ括弧のない IPv6 リテラルは Error になる", () => {
  assert.throws(() => normalizeMoqtUri("moqt://[::1/moqt"), Error, /unterminated ipv6 host/);
  assert.throws(() => normalizeMoqtUri("moqt://[::1"), Error, /unterminated ipv6 host/);
});

// ---- normalizeMoqtUri: userinfo (RFC 3986 §3.2 の authority) ----

test("userinfo は https URL の userinfo として保持される", () => {
  const result = normalizeMoqtUri("moqt://user:pass@example.com/moqt");
  assert.equal(result.url, "https://user:pass@example.com/moqt");
});

test("userinfo のパスワードに含まれる @ は最後の @ までが userinfo として扱われる", () => {
  // authority の切り出しは lastIndexOf("@") のため、パスワード中の @ は userinfo に残り、
  // URL 正規化でパーセントエンコードされる
  const result = normalizeMoqtUri("moqt://user:p@ss@example.com/moqt");
  assert.equal(result.url, "https://user:p%40ss@example.com/moqt");
});

test("user 名が空の userinfo は URL 正規化で除去される", () => {
  const result = normalizeMoqtUri("moqt://@example.com/moqt");
  assert.equal(result.url, "https://example.com/moqt");
});

test("userinfo の後ろに host が無い場合は Error になる", () => {
  assert.throws(() => normalizeMoqtUri("moqt://user@/moqt"), Error, /empty host/);
});

// ---- normalizeMoqtUri: ポート ----

test("範囲外のポートは Error になる", () => {
  assert.throws(() => normalizeMoqtUri("moqt://example.com:99999/moqt"), Error, /invalid url/);
});

test("数値でないポートは Error になる", () => {
  assert.throws(() => normalizeMoqtUri("moqt://example.com:abc/moqt"), Error, /invalid url/);
});

test("空ポートは URL 正規化で除去される", () => {
  const result = normalizeMoqtUri("moqt://example.com:/moqt");
  assert.equal(result.url, "https://example.com/moqt");
});

test("ポートのみ (host なし) は Error になる", () => {
  assert.throws(() => normalizeMoqtUri("moqt://:4443/moqt"), Error, /empty host/);
});

// ---- parseFragment ----

test("parseFragment: 正しい形式 type:value がパースされる", () => {
  assert.deepEqual(parseFragment("track:video"), { type: "track", value: "video" });
});

test("parseFragment: 数字とハイフンを含む type が許容される", () => {
  assert.deepEqual(parseFragment("type-1-2:value"), { type: "type-1-2", value: "value" });
});

test("parseFragment: value が空でも受理される", () => {
  assert.deepEqual(parseFragment("type:"), { type: "type", value: "" });
});

test("parseFragment: value にコロンが含まれる場合は最初のコロンで分割される", () => {
  assert.deepEqual(parseFragment("type:val:ue"), { type: "type", value: "val:ue" });
});

test("parseFragment: 空文字列は Error になる", () => {
  assert.throws(() => parseFragment(""), Error, /fragment must not be empty/);
});

test("parseFragment: コロンがない場合 Error になる", () => {
  assert.throws(() => parseFragment("novalue"), Error, /must contain a colon separator/);
});

test("parseFragment: type が空の場合 Error になる", () => {
  assert.throws(() => parseFragment(":value"), Error, /type identifier must not be empty/);
});

test("parseFragment: type に大文字を含む場合 Error になる", () => {
  assert.throws(
    () => parseFragment("TYPE:value"),
    Error,
    /ASCII lowercase letters, digits, and hyphens/,
  );
});

test("parseFragment: type に記号を含む場合 Error になる", () => {
  assert.throws(
    () => parseFragment("type_x:value"),
    Error,
    /ASCII lowercase letters, digits, and hyphens/,
  );
});

test("parseFragment: type にスペースを含む場合 Error になる", () => {
  assert.throws(
    () => parseFragment("ty pe:value"),
    Error,
    /ASCII lowercase letters, digits, and hyphens/,
  );
});
