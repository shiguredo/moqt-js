/**
 * c4m の伏せ字の性質
 *
 * 伏せ字は「認可トークンを外部へ出さない」ための最後の砦である。任意の parameter 列に
 * ついて、値が残らないこと・他の parameter を壊さないことを確かめる。
 */

import { test, assert } from "vite-plus/test";
import * as fc from "fast-check";
import { extractC4mBase64, maskC4mValue } from "./c4m";

// 伏せ字にすると値が `<redacted>` になるため、c4m の値として妥当な Base64 を生成する
const base64Arbitrary = fc.stringMatching(/^[A-Za-z0-9+/]{4,24}$/);
// parameter 名は c4m 以外 (伏せ字の対象外であることを確かめる)
const parameterNameArbitrary = fc
  .stringMatching(/^[a-z][a-z0-9-]{0,9}$/)
  .filter((name) => name !== "c4m");
const parameterValueArbitrary = fc.stringMatching(/^[A-Za-z0-9._-]{1,12}$/);

/** `msf:track-identifier&key=value&...` の形の fragment を生成する */
const fragmentArbitrary = fc
  .record({
    trackIdentifier: fc.stringMatching(/^[a-z0-9-]{1,12}$/),
    c4mValue: base64Arbitrary,
    parameters: fc.array(
      fc.record({ name: parameterNameArbitrary, value: parameterValueArbitrary }),
      {
        maxLength: 4,
      },
    ),
  })
  .map(({ trackIdentifier, c4mValue, parameters }) => {
    const others = parameters.map((parameter) => `${parameter.name}=${parameter.value}`);
    return `msf:${trackIdentifier}&c4m=${c4mValue}${others.length === 0 ? "" : `&${others.join("&")}`}`;
  });

test("maskC4mValue: 伏せ字にした出力からは c4m を取り出せない", () => {
  // 値そのものが残っていれば extractC4mBase64 が取り出せてしまう
  fc.assert(
    fc.property(fragmentArbitrary, (fragment) => {
      assert.equal(extractC4mBase64(maskC4mValue(fragment)), undefined);
    }),
    { numRuns: 200 },
  );
});

test("maskC4mValue: 2 回かけても結果が変わらない", () => {
  fc.assert(
    fc.property(fragmentArbitrary, (fragment) => {
      const once = maskC4mValue(fragment);
      assert.equal(maskC4mValue(once), once);
    }),
    { numRuns: 200 },
  );
});

test("maskC4mValue: c4m 以外の parameter と track-identifier は変えない", () => {
  fc.assert(
    fc.property(fragmentArbitrary, (fragment) => {
      const masked = maskC4mValue(fragment);
      const before = fragment.split("&");
      const after = masked.split("&");

      // parameter の数は変わらない
      assert.equal(after.length, before.length);
      for (const [index, segment] of before.entries()) {
        if (segment.startsWith("c4m=")) {
          assert.equal(after[index], "c4m=<redacted>");
        } else {
          assert.equal(after[index], segment);
        }
      }
    }),
    { numRuns: 200 },
  );
});

test("maskC4mValue: 複数行の本文へかけても、c4m の後ろの行を消さない", () => {
  // Copy for LLM の本文全体へかけるため、値の範囲が行をまたぐと後続の節が消える
  fc.assert(
    fc.property(
      fragmentArbitrary,
      fc.stringMatching(/^[A-Za-z0-9 =:._-]{1,20}$/),
      (fragment, trailingLine) => {
        const masked = maskC4mValue(`${fragment}\n${trailingLine}`);
        assert.equal(masked.split("\n")[1], trailingLine);
      },
    ),
    { numRuns: 200 },
  );
});

test("maskC4mValue: c4m を含まない入力は変えない", () => {
  const withoutC4m = fc
    .stringMatching(/^[A-Za-z0-9:._\-/]{0,40}$/)
    .filter((value) => !value.includes("c4m="));
  fc.assert(
    fc.property(withoutC4m, (value) => {
      assert.equal(maskC4mValue(value), value);
    }),
    { numRuns: 200 },
  );
});
