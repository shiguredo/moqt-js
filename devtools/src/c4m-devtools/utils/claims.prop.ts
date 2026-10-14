/**
 * C4M DevTools のクレーム入力の解釈と整形の Property-Based Testing
 *
 * 画面の入力 (テキスト) と `moqt` クレームの値 (`Match` / `NamespaceMatch`) の対応が
 * 逆写像であること、UNIX 秒の表示が元の時刻へ戻ることを任意の入力で確認する。対応が
 * 崩れると、画面で入力したマッチが実際に認可される値と食い違い、表示した時刻が元の
 * クレームと食い違う。
 *
 * 単体テストは仕様の代表値 1 つを固定する。ここでは `bin-match` の種類・パターンの
 * 長さ・名前空間マッチの並びを任意に作って同じ性質を確かめる。
 */

import { test, assert } from "vite-plus/test";
import * as fc from "fast-check";
import { C4M } from "moqt-js";
import { formatMatch, formatNamespaceMatches } from "../../utils/c4m";
import { formatUnixTime, parseMatch, parseNamespaceMatches, parseTrackMatch } from "./claims";

const TEXT_ENCODER = new TextEncoder();

/**
 * マッチのパターンに使う文字列
 *
 * `{a,b,c}` の 3 文字にする。`parseMatch` は入力を trim するため、前後に空白を持つ
 * パターンは表示と入力の往復で空白が落ちる。また exact のパターンが `prefix:` /
 * `suffix:` で始まると、表示を読み戻すときに修飾子として二重解釈される。どちらも
 * 書式として往復できない入力なので、生成域から外す。
 */
const patternArbitrary = fc.stringMatching(/^[abc]{1,64}$/, { size: "max" });

/** `bin-match` の 3 種類 (draft-ietf-moq-c4m-01 Section 2.1) */
const matchArbitrary: fc.Arbitrary<C4M.Match> = fc
  .tuple(
    fc.constantFrom<"exact" | "prefix" | "suffix">("exact", "prefix", "suffix"),
    patternArbitrary,
  )
  .map(([type, pattern]) => {
    const bytes = TEXT_ENCODER.encode(pattern);
    switch (type) {
      case "exact":
        return C4M.exactMatch(bytes);
      case "prefix":
        return C4M.prefixMatch(bytes);
      default:
        return C4M.suffixMatch(bytes);
    }
  });

/**
 * 名前空間マッチ列
 *
 * `end` (nil) は名前空間の末尾にだけ置けるため、生成でも末尾にだけ足す。空の列と
 * `end` だけの列も作る。途中に `end` がある列は入力として不正なので、生成域には
 * 入れない (拒否は別のテストで確かめる)。
 */
const namespaceArbitrary: fc.Arbitrary<C4M.NamespaceMatch[]> = fc
  .tuple(fc.array(matchArbitrary, { maxLength: 4, size: "max" }), fc.boolean())
  .map(([matches, withEnd]) => {
    const namespace = matches.map((match) => C4M.namespaceMatchValue(match));
    if (withEnd) {
      namespace.push(C4M.namespaceMatchEnd());
    }
    return namespace;
  });

// formatMatch が書き出したテキストを parseMatch が同じ Match へ戻すことを確認する。
// 3 種類 (exact / prefix / suffix) と任意の長さのパターンで確かめる。
test("マッチの表示と入力を任意のパターンで往復できる", () => {
  fc.assert(
    fc.property(matchArbitrary, (match) => {
      const text = formatMatch(match);

      assert.deepEqual(parseMatch(text), match);
      // トラック名の入力も空でなければ同じ解釈になる (表示は trim の対象外)
      assert.deepEqual(parseTrackMatch(text), match);
    }),
  );
});

// formatNamespaceMatches が書き出したテキストを parseNamespaceMatches が同じ列へ
// 戻すことを確認する。`end` の位置と列の長さを任意に作る。
test("名前空間マッチ列の表示と入力を往復できる", () => {
  fc.assert(
    fc.property(namespaceArbitrary, (namespace) => {
      assert.deepEqual(parseNamespaceMatches(formatNamespaceMatches(namespace)), namespace);
    }),
  );
});

// `end` は名前空間の末尾を固定する nil であり、途中に置けるのは最後の 1 つだけである。
// 単体テストの 1 例ではなく、前後に任意のマッチを置いた入力で拒否を確かめる。
test("名前空間マッチの入力は末尾以外の end を拒否する", () => {
  fc.assert(
    fc.property(
      fc.array(patternArbitrary, { minLength: 1, maxLength: 3, size: "max" }),
      patternArbitrary,
      (before, after) => {
        assert.throws(
          () => parseNamespaceMatches([...before, "end", after].join(", ")),
          /end must be the last namespace match/,
        );
      },
    ),
  );
});

// 表示は「ISO 8601 (UNIX 秒)」である。ISO 8601 を Date.parse で読み戻すと元のミリ秒に
// なり、括弧の中は入力の秒そのものになることを、任意の時刻で確かめる。年が 4 桁に
// 収まる 1696 年から 2243 年までを生成域にする。
test("formatUnixTime: 表示した ISO 8601 は元の時刻へ戻り、秒が併記される", () => {
  fc.assert(
    fc.property(fc.integer({ min: -8_640_000_000, max: 8_640_000_000 }), (seconds) => {
      const text = formatUnixTime(seconds);
      const matched = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z) \((-?\d+)\)$/.exec(text);

      assert.isNotNull(matched);
      if (matched === null) {
        return;
      }
      assert.equal(Date.parse(matched[1] ?? ""), seconds * 1000);
      assert.equal(Number(matched[2]), seconds);
    }),
  );
});
