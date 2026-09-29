/**
 * C4M DevTools のクレーム入力の解釈と整形のテスト
 */

import { test, assert } from "vite-plus/test";
import { C4M } from "moqt-js";
import {
  formatBytes,
  formatMatch,
  formatNamespaceMatches,
  formatUnixTime,
  parseList,
  parseMatch,
  parseNamespaceMatches,
  parseOptionalNumber,
  parseTrackMatch,
} from "./claims";

const TEXT_ENCODER = new TextEncoder();

test("マッチの入力を解釈できる", () => {
  assert.deepEqual(parseMatch("example.com"), C4M.exactMatch(TEXT_ENCODER.encode("example.com")));
  assert.deepEqual(parseMatch("prefix:live"), C4M.prefixMatch(TEXT_ENCODER.encode("live")));
  assert.deepEqual(
    parseMatch("suffix:.example.com"),
    C4M.suffixMatch(TEXT_ENCODER.encode(".example.com")),
  );
  assert.throws(() => parseMatch("  "), /empty match/);
});

test("名前空間マッチの入力を解釈できる", () => {
  assert.deepEqual(parseNamespaceMatches(""), []);
  assert.deepEqual(parseNamespaceMatches("example.com, prefix:live"), [
    C4M.namespaceMatchValue(C4M.exactMatch(TEXT_ENCODER.encode("example.com"))),
    C4M.namespaceMatchValue(C4M.prefixMatch(TEXT_ENCODER.encode("live"))),
  ]);
  assert.deepEqual(parseNamespaceMatches("example.com, end"), [
    C4M.namespaceMatchValue(C4M.exactMatch(TEXT_ENCODER.encode("example.com"))),
    C4M.namespaceMatchEnd(),
  ]);
  // end は末尾にだけ置ける
  assert.throws(() => parseNamespaceMatches("end, example.com"), /end must be the last/);
});

test("トラック名マッチの入力を解釈できる", () => {
  assert.equal(parseTrackMatch(""), undefined);
  assert.equal(parseTrackMatch("   "), undefined);
  assert.deepEqual(
    parseTrackMatch("suffix:-audio"),
    C4M.suffixMatch(TEXT_ENCODER.encode("-audio")),
  );
});

test("マッチの書式を往復できる", () => {
  const matches: C4M.NamespaceMatch[] = [
    C4M.namespaceMatchValue(C4M.exactMatch(TEXT_ENCODER.encode("example.com"))),
    C4M.namespaceMatchValue(C4M.prefixMatch(TEXT_ENCODER.encode("live"))),
    C4M.namespaceMatchEnd(),
  ];
  const text = formatNamespaceMatches(matches);
  assert.equal(text, "example.com, prefix:live, end");
  assert.deepEqual(parseNamespaceMatches(text), matches);
  const track = C4M.suffixMatch(TEXT_ENCODER.encode("-audio"));
  assert.equal(formatMatch(track), "suffix:-audio");
  assert.deepEqual(parseMatch(formatMatch(track)), track);
});

test("一覧と数値の入力を解釈できる", () => {
  assert.deepEqual(parseList("https://a.example, https://b.example ,"), [
    "https://a.example",
    "https://b.example",
  ]);
  assert.deepEqual(parseList(""), []);
  assert.equal(parseOptionalNumber("", "exp"), undefined);
  assert.equal(parseOptionalNumber("1700086400", "exp"), 1700086400);
  assert.equal(parseOptionalNumber("1.5", "iat"), 1.5);
  assert.throws(() => parseOptionalNumber("abc", "exp"), /exp must be a finite number/);
});

test("時刻とバイト列を整形できる", () => {
  assert.equal(formatUnixTime(1700086400), "2023-11-15T22:13:20.000Z (1700086400)");
  assert.equal(formatBytes(new Uint8Array([0x00, 0xab])), "00ab");
});
