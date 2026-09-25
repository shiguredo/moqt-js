/**
 * Server URL を OPFS に残すかの判定
 *
 * Save を押したときだけ書き、Purge を押したときは消す。
 */

import { assert, test } from "vite-plus/test";
import {
  parseStoredServerUrl,
  queryServerUrl,
  serverUrlMemoryButton,
  storedServerUrlAction,
} from "./serverUrlStore";

test("storedServerUrlAction: Remember を選んだ URL は書く", () => {
  assert.deepEqual(storedServerUrlAction("moqt://example.test:4443/", true), {
    kind: "write",
    url: "moqt://example.test:4443/",
  });
  // 前後の空白は捨てる
  assert.deepEqual(storedServerUrlAction("  moqt://example.test:4443/  ", true), {
    kind: "write",
    url: "moqt://example.test:4443/",
  });
});

test("storedServerUrlAction: Remember を外したときは消す", () => {
  assert.deepEqual(storedServerUrlAction("moqt://example.test:4443/", false), { kind: "delete" });
});

test("storedServerUrlAction: Remember を選んでも空欄なら消す", () => {
  assert.deepEqual(storedServerUrlAction("   ", true), { kind: "delete" });
});

test("parseStoredServerUrl: 空白を除いた 1 行だけを URL にする", () => {
  assert.equal(parseStoredServerUrl("  moqt://example.test:4443/ \n"), "moqt://example.test:4443/");
  assert.equal(parseStoredServerUrl(""), null);
  assert.equal(parseStoredServerUrl("   "), null);
  assert.equal(parseStoredServerUrl("moqt://a/\nmoqt://b/"), null);
});

test("serverUrlMemoryButton: 覚えていない URL は Save", () => {
  assert.deepEqual(serverUrlMemoryButton(null, "moqt://example.test:4443/"), {
    kind: "save",
    disabled: false,
  });
  // 空欄では Save を押せない
  assert.deepEqual(serverUrlMemoryButton(null, "   "), { kind: "save", disabled: true });
});

test("serverUrlMemoryButton: 覚えた URL と欄が同じときと、欄を空にしたときは Purge", () => {
  assert.deepEqual(
    serverUrlMemoryButton("moqt://example.test:4443/", "moqt://example.test:4443/"),
    {
      kind: "purge",
    },
  );
  // 前後の空白は同じ URL とみなす
  assert.deepEqual(
    serverUrlMemoryButton("moqt://example.test:4443/", "  moqt://example.test:4443/  "),
    { kind: "purge" },
  );
  assert.deepEqual(serverUrlMemoryButton("moqt://example.test:4443/", ""), { kind: "purge" });
});

test("serverUrlMemoryButton: 欄を覚えた URL から変えたときは Save", () => {
  assert.deepEqual(
    serverUrlMemoryButton("moqt://saved.example:4443/", "moqt://edited.example:4443/"),
    {
      kind: "save",
      disabled: false,
    },
  );
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
