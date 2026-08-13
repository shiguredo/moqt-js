/**
 * Range Filter 評価ロジックの Property-Based Tests
 * draft-ietf-moq-transport-19 Section 5.1.3 (Range Filters)
 */

import { test, assert } from "vite-plus/test";
import * as fc from "fast-check";
import { evaluateRangeFilters, mergeRangeFilters } from "./filter";
import type { RangeFilterSpec } from "./message/parameter";

/**
 * OBJECTID_FILTER: 任意の Range 列に対して、両端を含む (inclusive) 判定と
 * 範囲外の不通過を検証する。
 *
 * 生成された Range 列はソート済み・非重複 (start > 前の end) とし、
 * 対象 objectId が「いずれかの Range に含まれる」ことと評価結果の通過が
 * 一致することを確認する。
 */
test("evaluateRangeFilters: OBJECTID_FILTER は両端を含む Range 判定をする", () => {
  fc.assert(
    fc.property(
      fc.array(
        fc.record({
          start: fc.integer({ min: 0, max: 99 }),
          end: fc.option(fc.integer({ min: 0, max: 199 }), { nil: undefined }),
        }),
        { minLength: 1, maxLength: 10 },
      ),
      fc.integer({ min: 0, max: 199 }),
      (rawRanges, objectId) => {
        // ソート済みの Range 列に変換する (end 省略は open-ended)
        const ranges = rawRanges
          .sort((a, b) => a.start - b.start)
          .map((raw) => ({
            start: BigInt(raw.start),
            end: raw.end === undefined ? undefined : BigInt(raw.end),
          }));

        const filters: RangeFilterSpec[] = [{ type: "objectId", setId: 0, ranges }];
        const target = BigInt(objectId);

        const inRange = ranges.some(
          (range) => target >= range.start && (range.end === undefined || target <= range.end),
        );
        assert.equal(evaluateRangeFilters(filters, { objectId: target }), inRange);
      },
    ),
  );
});

/**
 * mergeRangeFilters: 任意の置換 update を 2 回適用しても結果が変わらない
 * (置換は Parameter Type 単位のため冪等)。
 */
test("mergeRangeFilters: 同一 update の 2 回適用は冪等", () => {
  fc.assert(
    fc.property(
      fc.array(
        fc.record({
          setId: fc.integer({ min: 0, max: 3 }),
          start: fc.integer({ min: 0, max: 99 }),
        }),
        { minLength: 1, maxLength: 8 },
      ),
      (rawSpecs) => {
        const update: RangeFilterSpec[] = rawSpecs.map((raw) => ({
          type: "objectId" as const,
          setId: raw.setId,
          ranges: [{ start: BigInt(raw.start) }],
        }));
        const once = mergeRangeFilters(undefined, update);
        const twice = mergeRangeFilters(once, update);
        assert.deepEqual(twice, once);
      },
    ),
  );
});

/**
 * mergeRangeFilters: 置換適用後は、update に含まれる Parameter Type の
 * インスタンスのみが残り、他の型は影響を受けない。
 */
test("mergeRangeFilters: 置換後の型は update のインスタンスのみで構成される", () => {
  fc.assert(
    fc.property(
      fc.array(
        fc.record({
          setId: fc.integer({ min: 0, max: 2 }),
          start: fc.integer({ min: 0, max: 99 }),
        }),
        { minLength: 1, maxLength: 5 },
      ),
      (rawSpecs) => {
        const current: RangeFilterSpec[] = [
          { type: "subgroup", setId: 0, ranges: [{ start: 0n }] },
        ];
        const update: RangeFilterSpec[] = rawSpecs.map((raw) => ({
          type: "objectId" as const,
          setId: raw.setId,
          ranges: [{ start: BigInt(raw.start) }],
        }));
        // current が undefined でないため、結果も undefined にならない
        const result = mergeRangeFilters(current, update)!;

        // 置換対象 (objectId) は update のインスタンスのみ
        const objectIdSpecs = result.filter((spec) => spec.type === "objectId");
        assert.equal(objectIdSpecs.length, update.length);
        // 他の型 (subgroup) は影響を受けない
        assert.deepEqual(
          result.filter((spec) => spec.type === "subgroup"),
          current,
        );
      },
    ),
  );
});
