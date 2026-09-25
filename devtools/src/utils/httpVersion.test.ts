/**
 * resolvePanelHttpVersion / isChromium のテスト
 *
 * 確立した WebTransport を画面の H2 / H3 にする。
 * W3C WebTransport の reliability
 * https://www.w3.org/TR/webtransport/#dom-webtransport-reliability
 * は安定版の Chromium には無い。属性が無い Chromium は HTTP/3 しか確立しない。
 */

import { assert, test } from "vite-plus/test";
import { formatPanelHttpVersion, isChromium, resolvePanelHttpVersion } from "./httpVersion";

test("supports-unreliable は H3 になる", () => {
  // datagram を運べる接続は HTTP/3。Chromium かどうかは見ない
  assert.equal(resolvePanelHttpVersion("supports-unreliable", false), "H3");
  assert.equal(resolvePanelHttpVersion("supports-unreliable", true), "H3");
});

test("reliable-only は H2 になる", () => {
  // 信頼性のみの接続は HTTP/2。属性が読めたときは Chromium の代替にしない
  assert.equal(resolvePanelHttpVersion("reliable-only", false), "H2");
  assert.equal(resolvePanelHttpVersion("reliable-only", true), "H2");
});

test("pending は出さない", () => {
  // 仕様の未確立。Chromium でも H3 と決めない
  assert.equal(resolvePanelHttpVersion("pending", true), null);
  assert.equal(resolvePanelHttpVersion("pending", false), null);
});

test("未知の文字列は出さない", () => {
  assert.equal(resolvePanelHttpVersion("unknown-value", true), null);
});

test("属性が無い Chromium は H3 になる", () => {
  // 安定版 Chrome は reliability を出さない。接続確立後に呼ぶ前提
  assert.equal(resolvePanelHttpVersion(undefined, true), "H3");
});

test("属性が無く Chromium でもないときは出さない", () => {
  assert.equal(resolvePanelHttpVersion(undefined, false), null);
});

test("UA-CH の brands に Chromium があれば Chromium とみなす", () => {
  assert.equal(
    isChromium({
      brands: [
        { brand: "Chromium", version: "140" },
        { brand: "Google Chrome", version: "140" },
      ],
    }),
    true,
  );
});

test("画面の文言は WebTransport over H3 / H2 を表す WT-H3 / WT-H2 にする", () => {
  // ページの HTTP バージョンではなく、WebTransport がどちらのトランスポートか
  assert.equal(formatPanelHttpVersion("H3"), "WT-H3");
  assert.equal(formatPanelHttpVersion("H2"), "WT-H2");
});

test("brands が無い、または Chromium を含まないときは Chromium とみなさない", () => {
  assert.equal(isChromium(undefined), false);
  assert.equal(isChromium({}), false);
  assert.equal(isChromium({ brands: [{ brand: "Firefox", version: "140" }] }), false);
});
