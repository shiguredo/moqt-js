/**
 * Server URL を OPFS に残すかの判定
 *
 * 共有リンクの `url` はそのままでは覚えず、空欄は覚えていた URL を消す。
 */

import { assert, test } from "vite-plus/test";
import { parseStoredServerUrl, queryServerUrl, storedServerUrlAction } from "./serverUrlStore";

test("storedServerUrlAction: 入力した URL は書く", () => {
  assert.deepEqual(storedServerUrlAction("moqt://example.test:4443/", null), {
    kind: "write",
    url: "moqt://example.test:4443/",
  });
  // 前後の空白は捨てる
  assert.deepEqual(storedServerUrlAction("  moqt://example.test:4443/  ", null), {
    kind: "write",
    url: "moqt://example.test:4443/",
  });
});

test("storedServerUrlAction: 共有リンクの url と同じときは書かない", () => {
  const queryUrl = "moqt://shared.example:4443/";
  assert.deepEqual(storedServerUrlAction(queryUrl, queryUrl), { kind: "skip" });
});

test("storedServerUrlAction: 共有リンクから書き換えた URL は書く", () => {
  assert.deepEqual(
    storedServerUrlAction("moqt://mine.example:4443/", "moqt://shared.example:4443/"),
    { kind: "write", url: "moqt://mine.example:4443/" },
  );
});

test("storedServerUrlAction: 空欄は覚えていた URL を消す", () => {
  assert.deepEqual(storedServerUrlAction("   ", null), { kind: "delete" });
  assert.deepEqual(storedServerUrlAction("", "moqt://shared.example:4443/"), { kind: "delete" });
});

test("parseStoredServerUrl: 空白を除いた 1 行だけを URL にする", () => {
  assert.equal(parseStoredServerUrl("  moqt://example.test:4443/ \n"), "moqt://example.test:4443/");
  assert.equal(parseStoredServerUrl(""), null);
  assert.equal(parseStoredServerUrl("   "), null);
  assert.equal(parseStoredServerUrl("moqt://a/\nmoqt://b/"), null);
});

test("queryServerUrl: url が無い、または空白だけのときは null", () => {
  assert.equal(queryServerUrl(""), null);
  assert.equal(queryServerUrl("?mode=subscriber"), null);
  assert.equal(queryServerUrl("?url="), null);
  assert.equal(queryServerUrl("?url=%20"), null);
  assert.equal(
    queryServerUrl("?url=moqt%3A%2F%2Fexample.test%3A4443%2F"),
    "moqt://example.test:4443/",
  );
});
