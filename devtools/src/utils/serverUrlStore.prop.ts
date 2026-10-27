/**
 * 接続先 (MOQT URI) の候補一覧の性質
 *
 * 保存形式と Copy URL の候補一覧が、任意の候補について往復すること、および有効な
 * 候補からの選択が候補の中からしか選ばないことを確かめる。これらは画面の操作では
 * 網羅しづらい組み合わせ (候補の数、有効 / 無効、fragment 付きの URI) を含む。
 */

import { assert, test } from "vite-plus/test";
import * as fc from "fast-check";
import {
  enabledServerUrlUrls,
  formatServerUrlCandidatesParam,
  formatServerUrlEntries,
  parseServerUrlCandidatesParam,
  parseServerUrlEntries,
  pickServerUrlCandidate,
  type ServerUrlEntry,
} from "./serverUrlStore";

/**
 * MOQT URI として読める値 (登録時の検証と urlCandidates の検証を通る)
 *
 * msf fragment は §11.1.2 の形式 (`namespace のフィールド -- track 名`) にし、空の
 * フィールドを作らないよう各要素は 1 文字以上の英数字にする。
 */
const moqtUriArbitrary = fc
  .tuple(
    fc.stringMatching(/^[a-z0-9]{1,20}$/),
    fc.stringMatching(/^[a-z0-9]{1,20}$/),
    fc.stringMatching(/^[a-z0-9]{1,20}$/),
    fc.boolean(),
  )
  .map(([host, path, trackName, withFragment]) => {
    const base = `moqt://${host}.example/${path}`;
    return withFragment ? `${base}#msf:${path}--${trackName}` : base;
  });

/** 保存形式として往復できる候補 (接続に使える MOQT URI と、有効 / 無効の組) */
const entriesArbitrary = fc
  .tuple(
    fc.uniqueArray(moqtUriArbitrary, { maxLength: 8 }),
    fc.array(fc.boolean(), { maxLength: 8 }),
  )
  .map(([urls, enabledFlags]): ServerUrlEntry[] =>
    urls.map((url, index) => ({ url, enabled: enabledFlags[index] ?? true })),
  );

// 保存形式 (`{ urlEntries: [...] }`) は任意の候補について読み戻せる
test("formatServerUrlEntries / parseServerUrlEntries: 任意の候補を往復できる", () => {
  fc.assert(
    fc.property(entriesArbitrary, (entries) => {
      assert.deepEqual(parseServerUrlEntries(formatServerUrlEntries(entries)), entries);
    }),
    { numRuns: 200 },
  );
});

// Copy URL の urlCandidates は、有効な候補の URI を重複なく読み戻せる
test("formatServerUrlCandidatesParam / parseServerUrlCandidatesParam: 有効な候補を往復できる", () => {
  fc.assert(
    fc.property(entriesArbitrary, (entries) => {
      const formatted = formatServerUrlCandidatesParam(entries);
      const expected = enabledServerUrlUrls(entries).map((url) => ({ url, enabled: true }));
      if (expected.length === 0) {
        assert.isNull(formatted);
        return;
      }
      assert.deepEqual(
        formatted === null ? null : parseServerUrlCandidatesParam(formatted),
        expected,
      );
    }),
    { numRuns: 200 },
  );
});

// 選択は乱数を候補の数で割った余りの位置の候補にする。候補が無ければ null
test("pickServerUrlCandidate: 任意の乱数を候補の位置へ写す", () => {
  fc.assert(
    fc.property(
      fc.uniqueArray(moqtUriArbitrary, { maxLength: 6 }),
      fc.nat(4294967295),
      (urls: string[], randomInt: number) => {
        const picked = pickServerUrlCandidate(urls, randomInt);
        if (urls.length === 0) {
          assert.isNull(picked);
          return;
        }
        assert.equal(picked, urls[randomInt % urls.length]);
      },
    ),
    { numRuns: 200 },
  );
});
