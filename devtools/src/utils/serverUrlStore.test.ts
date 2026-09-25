/**
 * Relay URI を OPFS に残すかの判定
 *
 * Save を押したときだけ書き、Forget を押したときは消す。
 */

import { assert, test } from "vite-plus/test";
import {
  parseStoredServerUrl,
  queryServerUrl,
  relayUriMemoryButtons,
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

test("relayUriMemoryButtons: 覚えていない URI は Save だけ押せる", () => {
  assert.deepEqual(relayUriMemoryButtons(null, "moqt://example.test:4443/"), {
    saveEnabled: true,
    forgetEnabled: false,
  });
  // 空欄では Save も Forget も押せない
  assert.deepEqual(relayUriMemoryButtons(null, "   "), {
    saveEnabled: false,
    forgetEnabled: false,
  });
});

test("relayUriMemoryButtons: 覚えた URI と欄が同じときと、欄を空にしたときは Forget だけ押せる", () => {
  assert.deepEqual(
    relayUriMemoryButtons("moqt://example.test:4443/", "moqt://example.test:4443/"),
    {
      saveEnabled: false,
      forgetEnabled: true,
    },
  );
  // 前後の空白は同じ URI とみなす
  assert.deepEqual(
    relayUriMemoryButtons("moqt://example.test:4443/", "  moqt://example.test:4443/  "),
    { saveEnabled: false, forgetEnabled: true },
  );
  assert.deepEqual(relayUriMemoryButtons("moqt://example.test:4443/", ""), {
    saveEnabled: false,
    forgetEnabled: true,
  });
});

test("relayUriMemoryButtons: 欄を覚えた URI から変えたときは Save だけ押せる", () => {
  assert.deepEqual(
    relayUriMemoryButtons("moqt://saved.example:4443/", "moqt://edited.example:4443/"),
    { saveEnabled: true, forgetEnabled: false },
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
