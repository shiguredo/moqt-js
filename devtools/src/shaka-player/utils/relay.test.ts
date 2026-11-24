import { assert, test } from "vitest";
import {
  buildShareQuery,
  buildShareUrl,
  maskRelayUrl,
  normalizeRelayUrl,
  parseEvictionGoalSeconds,
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
  assert.throws(() => parseNamespace(""), /Track Namespace is empty/);
  assert.throws(() => parseNamespace("a//b"), /empty field/);
  assert.throws(() => parseNamespace("a/b/"), /empty field/);
});

test("複数の namespace 行は拒否する", () => {
  assert.throws(() => parseNamespace("a/b\nc/d"), /only one Track Namespace is supported/);
});

test("devtools の - 区切り namespace をフィールドに変換する", () => {
  assert.deepEqual(parseNamespace("moqt-devtools-abc"), ["moqt", "devtools", "abc"]);
});

test("namespace-name の .hh エスケープを戻す", () => {
  assert.deepEqual(parseNamespace("a.2db"), ["a-b"]);
  assert.deepEqual(parseNamespace("a.2fb"), ["a/b"]);
});

test("ハイフン形式の空フィールドは拒否する", () => {
  assert.throws(() => parseNamespace("a--b"), /empty field/);
});

test("共有クエリに token を含めず、既定以外の設定を載せる", () => {
  const query = buildShareQuery({
    relayUrl: "moqt://relay.example.com/",
    namespaceText: "a/b",
    version: "draft-23",
    fingerprintUri: "https://relay.example.com/cert.sha256",
    evictionGoal: "12",
  });
  const params = new URLSearchParams(query);
  assert.equal(params.get("url"), "moqt://relay.example.com/");
  assert.equal(params.get("namespace"), "a/b");
  assert.equal(params.get("version"), "draft-23");
  assert.equal(params.get("fingerprintUri"), "https://relay.example.com/cert.sha256");
  assert.equal(params.get("evictionGoal"), "12");
  assert.isFalse(params.has("authorizationToken"));
});

test("共有クエリから空の値と既定値を除く", () => {
  // 値を省いたリンクを開き直しても、10 秒間隔を想定した 8 秒が使われる。
  const state = parseShareQuery("");
  assert.equal(state.evictionGoal, "8");
  assert.equal(buildShareQuery(state), "");
});

test("共有クエリを往復できる", () => {
  const state = {
    relayUrl: "moqt://relay.example.com:443/",
    namespaceText: "a/b",
    version: "draft-22",
    fingerprintUri: "",
    // Shaka の素の既定値でも、ページの既定値とは異なるため省略しない。
    evictionGoal: "1",
  };
  assert.deepEqual(parseShareQuery(`?${buildShareQuery(state)}`), state);
});

test("不正な削除しきい値はフォームで拒否し、共有クエリでは既定値へ戻す", () => {
  // 0 や小数、10 進整数ではない表記、安全に整数として表せない値を設定へ渡さない。
  for (const value of ["", "0", "-1", "1.5", "0x08", "1e1", "NaN", "9007199254740992"]) {
    assert.throws(() => parseEvictionGoalSeconds(value), /Buffer Eviction Goal/);
    const query = new URLSearchParams({ evictionGoal: value });
    assert.equal(parseShareQuery(query.toString()).evictionGoal, "8");
  }
});

test("共有 URL は現在の URL のクエリだけを置き換える", () => {
  assert.equal(
    buildShareUrl("https://example.com/shaka-player/?old=1#hash", {
      relayUrl: "moqt://relay.example.com/",
      namespaceText: "a/b",
      version: "auto",
      fingerprintUri: "",
      evictionGoal: "8",
    }),
    "https://example.com/shaka-player/?url=moqt%3A%2F%2Frelay.example.com%2F&namespace=a%2Fb",
  );
});

test("relay URL は scheme と port を残してマスクする", () => {
  assert.equal(maskRelayUrl("moqt://relay.example.com:443/"), "moqt://***:443/");
  assert.equal(maskRelayUrl("moqt://relay.example.com/"), "moqt://***/");
  assert.equal(maskRelayUrl("https://relay.example.com/"), "https://***/");
  assert.equal(maskRelayUrl(""), "");
  assert.equal(maskRelayUrl("not a url"), "***");
});
