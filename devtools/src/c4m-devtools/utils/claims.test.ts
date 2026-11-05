/**
 * C4M DevTools のクレーム入力の解釈と整形のテスト
 */

import { test, assert } from "vite-plus/test";
import { C4M } from "moqt-js";
import { formatMatch, formatNamespaceMatches } from "../../utils/c4m";
import {
  formatClaimValidity,
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
});

test("moqt-reval を持つトークンは再検証が必要である旨を別に表示する", () => {
  // 本ツールは再検証を行わないため、moqt-reval が正の値を持つトークンは
  // validateCatClaims の既定で revalidationNotSupported になる。トークン自体は
  // 有効であるため invalid ではなく、再検証が必要である旨を表示する
  const reval = C4M.createCatClaims();
  reval.moqtReval = 300;
  assert.equal(
    formatClaimValidity(reval, 1700086400),
    "valid, requires revalidation every 300 seconds (this tool does not revalidate)",
  );

  // 他のクレームが不正なら、再検証の有無に関係なく invalid と表示する。
  // 期限切れの exp と正の moqt-reval を同時に持つ場合は、revalidationSupported を
  // true にしてもう一度検証して期限切れを検出する
  const expiredWithReval = C4M.createCatClaims();
  expiredWithReval.expiration = 1000;
  expiredWithReval.moqtReval = 300;
  assert.equal(formatClaimValidity(expiredWithReval, 1000), "invalid: expired");

  // 負の再検証間隔は moqt-reval 自体が不正である
  const negativeReval = C4M.createCatClaims();
  negativeReval.moqtReval = -1;
  assert.equal(formatClaimValidity(negativeReval, 0), "invalid: invalidMoqtReval");

  // 通常の有効な claims はそのまま valid と表示する
  assert.equal(formatClaimValidity(C4M.createCatClaims(), 0), "valid at the current time");
});
