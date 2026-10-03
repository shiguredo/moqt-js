/**
 * Full Track Name の比較キーと文字列表現 Property-Based Tests
 * draft-ietf-moq-transport-22 Section 2.4.1 (Track Naming) / Section 8.8
 * (Representing Namespace and Track Names)
 */

import { test, assert } from "vite-plus/test";
import * as fc from "fast-check";
import { formatFullTrackName, formatTrackNamespace, fullTrackNameKey } from "./fullTrackName";
import { SubscriberImpl } from "./subscriber";
import { FetcherImpl } from "./fetcher";
import { parseMsfFragmentValue } from "./msf/fragment";

/**
 * フィールド境界の曖昧さを突く文字を含む Track Namespace Field / Track Name の Arbitrary
 *
 * 区切り文字として使っていた "/" に加え、長さ付きキーで境界に使う ":" と "|"、
 * 長さ表現と値の境目を狙う数字列を混ぜる。併せて任意の文字列 (サロゲートペアを
 * 含む Unicode) も生成し、長さが UTF-16 コードユニット数でも境界が保たれることを
 * 確かめる。空文字列も生成対象に含める。空の Track Namespace Field は
 * draft-ietf-moq-transport-22 §8.7 が 1 バイト以上を MUST とするため wire 上は
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
 * draft-ietf-moq-transport-22 §2.4.1:
 * 同じ Full Track Name は常に同じ比較キーになる。配列の参照に依存せず、
 * 内容が同じ別配列から生成してもキーが一致することを確かめる。
 *
 * 比較キーの生成経路が一致していること (Impl の getFullTrackNameKey と free 関数) は
 * 別のテストで検証する。
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
 * draft-ietf-moq-transport-22 §2.4.1:
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
 * draft-ietf-moq-transport-22 §2.4.1:
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

/**
 * draft-ietf-moq-transport-22 §2.4.1:
 * 比較キーの生成経路が一致していることを検証する。受信 PUBLISH の重複判定は
 * free 関数 `fullTrackNameKey` を、cross-cancel は各 Impl の
 * `getFullTrackNameKey()` を使うため、片方だけ形式が変わると同一 Track が
 * 不一致になり cross-cancel が無言で空振りする。
 */
test("getFullTrackNameKey は fullTrackNameKey と同じ比較キーを返す", () => {
  fc.assert(
    fc.property(fullTrackNameArb, ([namespace, trackName]) => {
      const subscriber = new SubscriberImpl(namespace, trackName, 0n, 0n, () => {});
      const fetcher = new FetcherImpl(namespace, trackName, 0n, () => {});

      assert.equal(subscriber.getFullTrackNameKey(), fullTrackNameKey(namespace, trackName));
      assert.equal(fetcher.getFullTrackNameKey(), fullTrackNameKey(namespace, trackName));
    }),
  );
});

/**
 * §8.8 の文字列表現の round-trip に使う Track Namespace Field / Track Name の Arbitrary
 *
 * Track Namespace Field は §8.7 が 1 バイト以上を MUST とするため空を生成しない。
 * Track Name も MSF fragment (§11.1.2) が空を許さないため 1 文字以上にする。
 * エスケープ対象の構造文字 (`-` / `--` / `&` / `.` / `?` など) と、非 ASCII を
 * 含む valid な Unicode (`unit: "grapheme"` は孤立サロゲートを生成しない) を混ぜる。
 */
const displayFieldArb = fc.oneof(
  fc.constantFrom("-", "--", "&", ".", "|", "/", "?", "a-b", "a.2db", ".2d", "_", "0"),
  fc.string({ unit: "grapheme", minLength: 1, maxLength: 8 }),
);

const displayFullTrackNameArb = fc.tuple(
  fc.array(displayFieldArb, { maxLength: 3 }),
  displayFieldArb,
);

/**
 * draft-ietf-moq-transport-22 §8.8 と draft-ietf-moq-msf-01 §11.1.2:
 * 文字列表現は MSF fragment の namespace-name 文字列として parse でき、
 * Track Namespace と Track Name が元の値に戻らなければならない。
 */
test("formatFullTrackName: parseMsfFragmentValue と round-trip する", () => {
  fc.assert(
    fc.property(displayFullTrackNameArb, ([trackNamespace, trackName]) => {
      const formatted = formatFullTrackName(trackNamespace, trackName);
      // parameter 無しの track-identifier として parse できる
      const parsed = parseMsfFragmentValue(formatted);
      assert.deepEqual(parsed.trackNamespace, trackNamespace);
      assert.equal(parsed.trackName, trackName);
      assert.deepEqual(parsed.parameters, []);
    }),
  );
});

/**
 * draft-ietf-moq-transport-22 §8.8 と draft-ietf-moq-msf-01 §11.1.2:
 * namespace 単体の文字列表現も、Full Track Name の -- の左側としてそのまま
 * parse でき、Track Namespace が元の値に戻らなければならない。
 */
test("formatTrackNamespace: parseMsfFragmentValue と round-trip する", () => {
  fc.assert(
    fc.property(fc.array(displayFieldArb, { maxLength: 3 }), (trackNamespace) => {
      // 空の namespace は "--" だけになるが、parse 側は空 tuple として許容する
      const formatted = `${formatTrackNamespace(trackNamespace)}--x`;
      const parsed = parseMsfFragmentValue(formatted);
      assert.deepEqual(parsed.trackNamespace, trackNamespace);
    }),
  );
});

/**
 * draft-ietf-moq-transport-22 §2.4.1 / §8.8:
 * 異なる Full Track Name が同じ文字列になってはならない。"/" 連結では
 * namespace ["a"] + track "b/c" と namespace ["a","b"] + track "c" が衝突していた。
 * 文字列が一致した場合は Track Namespace と Track Name の双方が一致していなければ
 * ならない (単射性)。
 */
test("formatFullTrackName: 異なる Full Track Name は同じ文字列にならない", () => {
  fc.assert(
    fc.property(
      displayFullTrackNameArb,
      displayFullTrackNameArb,
      ([namespaceA, trackNameA], [namespaceB, trackNameB]) => {
        const formattedA = formatFullTrackName(namespaceA, trackNameA);
        const formattedB = formatFullTrackName(namespaceB, trackNameB);
        if (formattedA !== formattedB) {
          return;
        }
        assert.deepEqual(namespaceA, namespaceB);
        assert.equal(trackNameA, trackNameB);
      },
    ),
  );
});
