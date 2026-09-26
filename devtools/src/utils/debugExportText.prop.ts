/**
 * Copy for LLM の本文の整形の性質
 *
 * スナップショットは任意の入れ子と値を取りうる。どのような入力でも例外を投げず、
 * すべてのキーが `キー:` の形で本文に現れる (項目を足したのに本文から抜けない) ことを
 * 任意の入力で確かめる。
 */

import { test, assert } from "vite-plus/test";
import * as fc from "fast-check";
import { formatSnapshotSection } from "./debugExportText";

// キーは識別子の形にする (入れ子のパスを組み立てるため)
const keyArbitrary = fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9_]{0,7}$/);
// 値は改行を含まない短い文字列、数値、真偽値、null のいずれか
const valueArbitrary = fc.oneof(
  fc.stringMatching(/^[\u0020-\u007E]{0,8}$/),
  fc.integer({ min: -1_000_000, max: 1_000_000 }),
  fc.double({ min: -1_000, max: 1_000, noNaN: true }),
  fc.boolean(),
  fc.constant(null),
);

/** オブジェクトのキーを入れ子も含めて集める */
function collectKeys(value: unknown, keys: Set<string>): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    keys.add(key);
    collectKeys(child, keys);
  }
}

test("formatSnapshotSection: 任意の値でもすべてのキーを本文に出す", () => {
  fc.assert(
    fc.property(
      fc.dictionary(keyArbitrary, valueArbitrary, { minKeys: 1, maxKeys: 8 }),
      (snapshot) => {
        const section = formatSnapshotSection("Test", snapshot);
        assert.isTrue(section.startsWith("=== Test ===\n"));

        for (const key of Object.keys(snapshot)) {
          assert.include(section, `${key}:`, `キー ${key} が本文にある`);
        }
      },
    ),
    { numRuns: 200 },
  );
});

test("formatSnapshotSection: 値が単純ならキー 1 つにつき 1 行にする", () => {
  // 数値・真偽値・null は入れ子にならないため、見出し 1 行 + キーの数だけ行になる。
  // 空文字列と null は "-" の 1 行になる
  const scalarArbitrary = fc.oneof(
    fc.integer({ min: -1_000_000, max: 1_000_000 }),
    fc.boolean(),
    fc.constant(null),
    fc.constant(""),
  );
  fc.assert(
    fc.property(
      fc.dictionary(keyArbitrary, scalarArbitrary, { minKeys: 1, maxKeys: 8 }),
      (snapshot) => {
        const lines = formatSnapshotSection("Test", snapshot).split("\n");
        assert.equal(lines.length, Object.keys(snapshot).length + 1);
      },
    ),
    { numRuns: 200 },
  );
});

test("formatSnapshotSection: 任意の入れ子でも例外を投げず、深いキーまで出す", () => {
  const nestedArbitrary = fc.letrec((tie) => ({
    value: fc.oneof(
      { depthSize: "small" },
      valueArbitrary,
      fc.array(tie("value"), { maxLength: 3 }),
      fc.dictionary(keyArbitrary, tie("value"), { maxKeys: 3 }),
    ),
  })).value;

  fc.assert(
    fc.property(
      fc.dictionary(keyArbitrary, nestedArbitrary, { minKeys: 1, maxKeys: 4 }),
      (snapshot) => {
        const section = formatSnapshotSection("Test", snapshot);
        const keys = new Set<string>();
        collectKeys(snapshot, keys);
        for (const key of keys) {
          assert.include(section, `${key}:`, `キー ${key} が本文にある`);
        }
      },
    ),
    { numRuns: 200 },
  );
});
