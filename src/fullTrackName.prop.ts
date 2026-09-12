/**
 * Full Track Name の比較キー Property-Based Tests
 * draft-ietf-moq-transport-21 Section 2.4.1 (Track Naming)
 */

import { test, assert } from "vite-plus/test";
import * as fc from "fast-check";
import { fullTrackNameKey } from "./fullTrackName";

/**
 * フィールド境界の曖昧さを突く文字を含む Track Namespace Field / Track Name の Arbitrary
 *
 * 区切り文字として使っていた "/" に加え、長さ付きキーで境界に使う ":" と "|"、
 * 長さ表現と値の境目を狙う数字列を混ぜる。併せて任意の文字列 (サロゲートペアを
 * 含む Unicode) も生成し、長さが UTF-16 コードユニット数でも境界が保たれることを
 * 確かめる。空文字列も生成対象に含める。空の Track Namespace Field は
 * draft-ietf-moq-transport-21 §8.7 が 1 バイト以上を MUST とするため wire 上は
 * 現れないが、キー生成が任意の入力で単射であることを確かめる。
 */
const boundaryFieldArb = fc.constantFrom(
  "",
  "a",
  "b",
  "ab",
  "0",
  "1",
  "12",
  "/",
  "|",
  ":",
  "a/b",
  "b/c",
  "1:a",
  "a|b",
  "1:a|b",
  "3:",
);

// 境界を突く値域に加え、任意長・任意 Unicode (サロゲートペアや孤立サロゲートを
// 含み得る binary 単位) の文字列も混ぜて探索空間を広げる
const fieldArb: fc.Arbitrary<string> = fc.oneof(
  boundaryFieldArb,
  fc.string({ maxLength: 8 }),
  fc.string({ unit: "binary", maxLength: 8 }),
);

const fullTrackNameArb = fc.tuple(fc.array(fieldArb, { maxLength: 4 }), fieldArb);

/**
 * draft-ietf-moq-transport-21 §2.4.1:
 * 同じ Full Track Name は常に同じ比較キーになる。配列の参照や生成経路に依存せず、
 * getFullTrackNameKey と受信 PUBLISH の比較キーが一致する前提を保証する。
 */
test("fullTrackNameKey: 同じ Full Track Name は同じキーになる", () => {
  fc.assert(
    fc.property(fullTrackNameArb, ([namespace, trackName]) => {
      const fromOriginal = fullTrackNameKey(namespace, trackName);
      // 内容が同じ別配列から生成しても一致する
      const fromCopy = fullTrackNameKey([...namespace], trackName);
      assert.equal(fromOriginal, fromCopy);
    }),
  );
});

/**
 * draft-ietf-moq-transport-21 §2.4.1:
 * 「comparison between two Track Namespace Fields or Track Names is done by
 *  exact comparison of the bytes」であり、異なる Full Track Name が同じ
 * 比較キーになってはならない。キーが一致した場合は Track Namespace と
 * Track Name の双方が一致していなければならない (単射性)。
 */
test("fullTrackNameKey: 異なる Full Track Name は同じキーにならない", () => {
  fc.assert(
    fc.property(
      fullTrackNameArb,
      fullTrackNameArb,
      ([namespaceA, trackNameA], [namespaceB, trackNameB]) => {
        const keyA = fullTrackNameKey(namespaceA, trackNameA);
        const keyB = fullTrackNameKey(namespaceB, trackNameB);
        if (keyA !== keyB) {
          return;
        }
        // キーが一致する場合のみ Full Track Name の一致を要求する
        assert.deepEqual(namespaceA, namespaceB);
        assert.equal(trackNameA, trackNameB);
      },
    ),
  );
});

/**
 * draft-ietf-moq-transport-21 §2.4.1:
 * Track Name に含まれる区切り文字と Track Namespace の分割が衝突しない。
 * namespace ["a"] + trackName "b/c" と namespace ["a","b"] + trackName "c" は
 * 旧実装 ("/" 連結) では常に同じキーになっていた組み合わせであり、
 * ランダム生成では衝突しにくいため構造を限定して直接検証する。
 */
test("fullTrackNameKey: Track Name 内の区切り文字と namespace 分割が衝突しない", () => {
  fc.assert(
    fc.property(
      // Track Namespace は 1 フィールド以上とする (先頭が空でも "/" 連結は衝突する)
      fc.array(fieldArb, { minLength: 1, maxLength: 4 }),
      fieldArb,
      fieldArb,
      (namespace, trackNameHead, trackNameTail) => {
        // namespace ["a"] + trackName "b/c" の形
        const inTrackName = fullTrackNameKey(namespace, `${trackNameHead}/${trackNameTail}`);
        // namespace ["a","b"] + trackName "c" の形
        const splitNamespace = fullTrackNameKey([...namespace, trackNameHead], trackNameTail);

        assert.notEqual(inTrackName, splitNamespace);
      },
    ),
  );
});
