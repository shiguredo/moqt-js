import { assert, test } from "vitest";
import {
  buildShareQuery,
  buildShareUrl,
  normalizeRelayUrl,
  parseNamespace,
  parseShareQuery,
} from "./relay";

test("moqt scheme を https に正規化する", () => {
  assert.equal(
    normalizeRelayUrl("moqt://relay.example.com:443/path"),
    "https://relay.example.com/path",
  );
});

test("https scheme はそのまま通す", () => {
  assert.equal(
    normalizeRelayUrl("https://relay.example.com/path?x=1"),
    "https://relay.example.com/path?x=1",
  );
});

test("https 以外と壊れた URL は拒否する", () => {
  assert.throws(() => normalizeRelayUrl(""), /relay URL is empty/);
  assert.throws(() => normalizeRelayUrl("not a url"), /not a valid URL/);
  assert.throws(() => normalizeRelayUrl("http://relay.example.com"), /moqt:\/\/ or https:\/\//);
});

test("namespace を / で分解する", () => {
  assert.deepEqual(parseNamespace("  shaka-demo/abc123  "), ["shaka-demo", "abc123"]);
});

test("空の namespace と空フィールドは拒否する", () => {
  assert.throws(() => parseNamespace(""), /namespace is empty/);
  assert.throws(() => parseNamespace("a//b"), /empty field/);
  assert.throws(() => parseNamespace("a/b/"), /empty field/);
});

test("複数の namespace 行は拒否する", () => {
  assert.throws(() => parseNamespace("a/b\nc/d"), /only one namespace is supported/);
});

test("共有クエリに token を含めず、auto 以外の version だけを載せる", () => {
  const query = buildShareQuery({
    relayUrl: "moqt://relay.example.com/",
    namespaceText: "a/b",
    version: "draft-23",
    fingerprintUri: "https://relay.example.com/cert.sha256",
  });
  const params = new URLSearchParams(query);
  assert.equal(params.get("url"), "moqt://relay.example.com/");
  assert.equal(params.get("namespace"), "a/b");
  assert.equal(params.get("version"), "draft-23");
  assert.equal(params.get("fingerprintUri"), "https://relay.example.com/cert.sha256");
  assert.isFalse(params.has("authorizationToken"));
});

test("共有クエリから空の値を除く", () => {
  assert.equal(
    buildShareQuery({
      relayUrl: "",
      namespaceText: "",
      version: "auto",
      fingerprintUri: "",
    }),
    "",
  );
});

test("共有クエリを往復できる", () => {
  const state = {
    relayUrl: "moqt://relay.example.com:443/",
    namespaceText: "a/b",
    version: "draft-22",
    fingerprintUri: "",
  };
  assert.deepEqual(parseShareQuery(`?${buildShareQuery(state)}`), state);
});

test("共有 URL は現在の URL のクエリだけを置き換える", () => {
  assert.equal(
    buildShareUrl("https://example.com/shaka-player/?old=1#hash", {
      relayUrl: "moqt://relay.example.com/",
      namespaceText: "a/b",
      version: "auto",
      fingerprintUri: "",
    }),
    "https://example.com/shaka-player/?url=moqt%3A%2F%2Frelay.example.com%2F&namespace=a%2Fb",
  );
});
