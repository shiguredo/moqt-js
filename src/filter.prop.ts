/**
 * Location Filter 解決の Property-Based Tests
 *
 * draft-ietf-moq-transport-21 Section 3.3.1 (Location Filters) /
 * Section 9.20.10 (LOCATION FILTER Parameter)
 *
 * resolveFilter は「LocationFilter の種別 × LARGEST_OBJECT の有無 × Location 値」の
 * 有限な離散パターンを扱う純粋関数であるため、任意の Location に対して
 * 成り立つ不変条件をプロパティとして検証する。
 */

import { test, assert } from "vite-plus/test";
import * as fc from "fast-check";
import {
  objectMatchesFilter,
  rangeFiltersMatch,
  resolveFilter,
  type RangeFilterValues,
} from "./filter";
import type { Location } from "./message/types";
import type { FilterRange, LocationFilter, RangeFilterSpec } from "./message/parameter";
import { locationFilterArb } from "./message/parameterArb";
import { compareLocations } from "./session/params";
import { MAX_VARINT } from "./varint";

// ============================================================================
// Arbitrary 定義
// ============================================================================

/**
 * 通常域の Location
 *
 * クランプや桁上がりの境界は別の arbitrary で狙うため、ここでは実運用に近い
 * 範囲に絞って探索空間を無駄に広げない。
 */
const locationArb: fc.Arbitrary<Location> = fc.record({
  group: fc.bigInt({ min: 0n, max: 1_000_000n }),
  object: fc.bigInt({ min: 0n, max: 1_000_000n }),
});

/** 全域の Location (クランプ境界を含む) */
const fullRangeLocationArb: fc.Arbitrary<Location> = fc.record({
  group: fc.bigInt({ min: 0n, max: MAX_VARINT }),
  object: fc.bigInt({ min: 0n, max: MAX_VARINT }),
});

/**
 * 境界を必ず含む Location
 *
 * 一様乱数では 2^64-1 や {0, 0} がほぼ生成されないため、クランプ分岐と
 * 未配信判定の境界 (LARGEST_OBJECT {0, 0} は「配信済み」) を定数で混ぜる。
 */
const boundaryLocationArb: fc.Arbitrary<Location> = fc.oneof(
  fc.constant({ group: 0n, object: 0n }),
  fc.constant({ group: 0n, object: MAX_VARINT }),
  fc.constant({ group: MAX_VARINT, object: 0n }),
  fc.constant({ group: MAX_VARINT, object: MAX_VARINT }),
  fc.constant({ group: MAX_VARINT - 1n, object: 0n }),
  fullRangeLocationArb,
);

/** LARGEST_OBJECT の有無 (null は未配信) */
const largestLocationArb: fc.Arbitrary<Location | null> = fc.oneof(fc.constant(null), locationArb);

/** 2 フィールド (絶対開始) の型 */
interface AbsoluteStartFilter {
  startGroup: bigint;
  startObject: bigint;
}

/** 3 フィールド (絶対開始 + End Group Delta) の型 */
interface AbsoluteRangeFilter extends AbsoluteStartFilter {
  endGroupDelta: bigint;
}

/** 4 フィールド (+ End Object) の型 */
interface AbsoluteRangeWithEndObjectFilter extends AbsoluteRangeFilter {
  endObject: bigint;
}

/** 2 フィールド (絶対開始) のうち 0:0 (Next Object) 以外 */
const absoluteStartArb: fc.Arbitrary<AbsoluteStartFilter> = fc
  .record({
    startGroup: fc.bigInt({ min: 0n, max: 1_000_000n }),
    startObject: fc.bigInt({ min: 0n, max: 1_000_000n }),
  })
  .filter((filter) => filter.startGroup !== 0n || filter.startObject !== 0n);

/** 2 フィールド 0:0 (Next Object) */
const nextObjectFilterArb: fc.Arbitrary<AbsoluteStartFilter> = fc.constant({
  startGroup: 0n,
  startObject: 0n,
});

/** 1 フィールド (相対指定) の型 */
interface RelativeGroupFilter {
  startGroup: bigint;
}

/** 1 フィールド (相対指定)。クランプ境界まで含める */
const relativeGroupFilterArb: fc.Arbitrary<RelativeGroupFilter> = fc
  .bigInt({ min: 0n, max: MAX_VARINT })
  .map((startGroup) => ({ startGroup }));

/** 3 フィールド (絶対開始 + End Group Delta) */
const absoluteRangeArb: fc.Arbitrary<AbsoluteRangeFilter> = fc
  .record({
    startGroup: fc.bigInt({ min: 0n, max: 1_000_000n }),
    startObject: fc.bigInt({ min: 0n, max: 1_000_000n }),
    endGroupDelta: fc.bigInt({ min: 0n, max: 1_000_000n }),
  })
  .filter((filter) => filter.startGroup !== 0n || filter.startObject !== 0n);

/** 4 フィールド (絶対開始 + End Group Delta + End Object) */
const absoluteRangeWithEndObjectArb: fc.Arbitrary<AbsoluteRangeWithEndObjectFilter> = fc
  .record({
    startGroup: fc.bigInt({ min: 0n, max: 1_000_000n }),
    startObject: fc.bigInt({ min: 0n, max: 1_000_000n }),
    endGroupDelta: fc.bigInt({ min: 0n, max: 1_000_000n }),
    endObject: fc.bigInt({ min: 0n, max: 1_000_000n }),
  })
  // 空の範囲 (End Object < Start Object) を作らない。空範囲では Start 自身が
  // 不通過になり、「Start は通過する」という不変条件を検証できないため
  .filter(
    (filter) =>
      (filter.startGroup !== 0n || filter.startObject !== 0n) &&
      filter.endObject >= filter.startObject,
  );

// ============================================================================
// フィルタなしに解決される種別
// ============================================================================

/**
 * draft-ietf-moq-transport-21 §9.20.10:
 * フィルタ未指定と Length 0 (reset) はどちらも「フィルタなし = 全 Object 通過」
 * (undefined) に解決される。LARGEST_OBJECT の有無に依存しない。
 */
test("resolveFilter: 未指定と reset は LARGEST_OBJECT に依存せず undefined になる (PBT)", () => {
  fc.assert(
    fc.property(largestLocationArb, (largestLocation) => {
      assert.isUndefined(resolveFilter(undefined, largestLocation));
      assert.isUndefined(resolveFilter({ reset: true }, largestLocation));
    }),
  );
});

// ============================================================================
// 絶対系 (2 / 3 / 4 フィールド)
// ============================================================================

/**
 * draft-ietf-moq-transport-21 §9.20.10:
 * startObject を持つ表現は絶対指定であり、LARGEST_OBJECT に依存しない。
 * 同じフィルタを未配信 (null) と配信済みで解決した結果が一致することを固定する。
 */
test("resolveFilter: 絶対系は LARGEST_OBJECT に依存しない (PBT)", () => {
  fc.assert(
    fc.property(
      fc.oneof(absoluteStartArb, absoluteRangeArb, absoluteRangeWithEndObjectArb),
      largestLocationArb,
      locationArb,
      (filter, largestLocation, otherLargest) => {
        const resolved = resolveFilter(filter, largestLocation);
        assert.deepEqual(resolveFilter(filter, null), resolved);
        assert.deepEqual(resolveFilter(filter, otherLargest), resolved);
      },
    ),
  );
});

/**
 * draft-ietf-moq-transport-21 §9.20.10:
 * 2 フィールド (startObject あり / endGroupDelta なし) は指定された絶対 Location を
 * そのまま start にし、終端を持たない。
 */
test("resolveFilter: 2 フィールドは絶対 Location を start にし終端を持たない (PBT)", () => {
  fc.assert(
    fc.property(absoluteStartArb, largestLocationArb, (filter, largestLocation) => {
      const resolved = resolveFilter(filter, largestLocation);
      assert.isDefined(resolved);
      assert.equal(resolved!.start.group, filter.startGroup);
      assert.equal(resolved!.start.object, filter.startObject);
      assert.isUndefined(resolved!.endGroup);
      assert.isUndefined(resolved!.endObject);
    }),
  );
});

/**
 * draft-ietf-moq-transport-21 §9.20.10:
 * 3 フィールドの End Group は StartGroup + EndGroupDelta であり、End Object を持たない
 * (End Group 全件が対象)。
 */
test("resolveFilter: 3 フィールドの End Group は StartGroup + Delta (PBT)", () => {
  fc.assert(
    fc.property(absoluteRangeArb, largestLocationArb, (filter, largestLocation) => {
      const resolved = resolveFilter(filter, largestLocation);
      assert.isDefined(resolved);
      assert.equal(resolved!.start.group, filter.startGroup);
      assert.equal(resolved!.start.object, filter.startObject);
      assert.equal(resolved!.endGroup, filter.startGroup + filter.endGroupDelta);
      assert.isUndefined(resolved!.endObject);
    }),
  );
});

/**
 * draft-ietf-moq-transport-21 §9.20.10:
 * 4 フィールドは 3 フィールドの解決結果に End Object を加えたものである。
 */
test("resolveFilter: 4 フィールドは End Object を保持する (PBT)", () => {
  fc.assert(
    fc.property(absoluteRangeWithEndObjectArb, largestLocationArb, (filter, largestLocation) => {
      const resolved = resolveFilter(filter, largestLocation);
      assert.isDefined(resolved);
      assert.equal(resolved!.start.group, filter.startGroup);
      assert.equal(resolved!.start.object, filter.startObject);
      assert.equal(resolved!.endGroup, filter.startGroup + filter.endGroupDelta);
      assert.equal(resolved!.endObject, filter.endObject);
    }),
  );
});

// ============================================================================
// 相対系 (1 フィールド / 2 フィールド 0:0)
// ============================================================================

/**
 * draft-ietf-moq-transport-21 §9.20.10:
 * 1 フィールドは Next Group 基準の相対指定であり、Start Location は
 * {Largest Object.Group + 1 - StartGroup, 0}。Object は常に 0 から始まる。
 *
 * 未配信 (LARGEST_OBJECT 未受信) は仕様どおり {0, 0} から開始する。
 * フォールバック値に +1 を適用して {0, 1} になる退行を検出する。
 */
test("resolveFilter: 1 フィールドは Next Group 基準で Object 0 から開始する (PBT)", () => {
  fc.assert(
    fc.property(relativeGroupFilterArb, boundaryLocationArb, (filter, largestLocation) => {
      const resolved = resolveFilter(filter, largestLocation);
      assert.isDefined(resolved);
      // Object は常に 0 (Next Group の先頭から)
      assert.equal(resolved!.start.object, 0n);
      assert.isUndefined(resolved!.endGroup);
      assert.isUndefined(resolved!.endObject);
      // 負値は 0、2^64-1 超過は 2^64-1 にクランプする
      const expected = largestLocation.group + 1n - filter.startGroup;
      if (expected < 0n) {
        assert.equal(resolved!.start.group, 0n);
      } else if (expected > MAX_VARINT) {
        assert.equal(resolved!.start.group, MAX_VARINT);
      } else {
        assert.equal(resolved!.start.group, expected);
      }
    }),
  );
});

/**
 * draft-ietf-moq-transport-21 §9.20.10:
 * 1 フィールドで LARGEST_OBJECT 未受信のときは {0, 0} から開始する。
 * フォールバック値に +1 を適用する退行 (未配信時に {0, 1}) を検出する。
 */
test("resolveFilter: 1 フィールドで未配信時は {0, 0} になる (PBT)", () => {
  fc.assert(
    fc.property(relativeGroupFilterArb, (filter) => {
      const resolved = resolveFilter(filter, null);
      assert.isDefined(resolved);
      assert.equal(resolved!.start.group, 0n);
      assert.equal(resolved!.start.object, 0n);
      assert.isUndefined(resolved!.endGroup);
    }),
  );
});

/**
 * draft-ietf-moq-transport-21 §9.20.10:
 * 2 フィールド 0:0 は Next Object ({Largest Object.Group, Largest Object.Object + 1})。
 * LARGEST_OBJECT の +1 漏れ (Largest Object 自身から開始する退行) を検出する。
 */
test("resolveFilter: 2 フィールド 0:0 は LARGEST_OBJECT の次 Object から開始する (PBT)", () => {
  fc.assert(
    fc.property(nextObjectFilterArb, boundaryLocationArb, (filter, largestLocation) => {
      const resolved = resolveFilter(filter, largestLocation);
      assert.isDefined(resolved);
      assert.equal(resolved!.start.group, largestLocation.group);
      assert.equal(resolved!.start.object, largestLocation.object + 1n);
      assert.isUndefined(resolved!.endGroup);
      assert.isUndefined(resolved!.endObject);
    }),
  );
});

/**
 * draft-ietf-moq-transport-21 §9.20.10:
 * 2 フィールド 0:0 で LARGEST_OBJECT 未受信のときは {0, 0} から開始する
 * (Next GroupStart と同じ扱い)。+1 を適用する退行 (未配信時に {0, 1}) を検出する。
 */
test("resolveFilter: 2 フィールド 0:0 で未配信時は {0, 0} になる (PBT)", () => {
  fc.assert(
    fc.property(nextObjectFilterArb, (filter) => {
      const resolved = resolveFilter(filter, null);
      assert.isDefined(resolved);
      assert.equal(resolved!.start.group, 0n);
      assert.equal(resolved!.start.object, 0n);
      assert.isUndefined(resolved!.endGroup);
    }),
  );
});

// ============================================================================
// 全種別に共通の不変条件
// ============================================================================

/**
 * 「フィルタなしに解決される種別」以外は必ず ResolvedFilter を返し、その Start は
 * Location として妥当 (Group / Object が 0〜2^64-1) である。
 * 併せて、解決結果が入力フィルタの種別と対応する終端を持つことを確認する。
 */
test("resolveFilter: 任意のフィルタで解決結果の Start が 0〜2^64-1 に収まる (PBT)", () => {
  fc.assert(
    fc.property(locationFilterArb, fullRangeLocationArb, (filter, largestLocation) => {
      const resolved = resolveFilter(filter, largestLocation);
      if (filter === undefined || "reset" in filter) {
        assert.isUndefined(resolved);
        return;
      }
      assert.isDefined(resolved);
      assert.isTrue(resolved!.start.group >= 0n && resolved!.start.group <= MAX_VARINT);
      assert.isTrue(resolved!.start.object >= 0n && resolved!.start.object <= MAX_VARINT);
      // End Group を持つ種別では End Object は End Group を持つ場合のみ現れる
      if (!("endGroupDelta" in filter)) {
        assert.isUndefined(resolved!.endGroup);
      }
      if (!("endObject" in filter)) {
        assert.isUndefined(resolved!.endObject);
      } else {
        assert.equal(resolved!.endObject, filter.endObject);
      }
    }),
  );
});

// ============================================================================
// objectMatchesFilter のテスト
// ============================================================================

/** 終端を持たない (endGroup なし) に解決されるフィルタ */
const noEndGroupFilterArb: fc.Arbitrary<{
  filter: LocationFilter;
  largestLocation: Location | null;
}> = fc.oneof(
  // 2 フィールド (絶対開始・終端なし)
  absoluteStartArb.map((filter) => ({ filter: filter as LocationFilter, largestLocation: null })),
  // 1 フィールド (相対指定・終端なし)
  fc.record({ filter: relativeGroupFilterArb, largestLocation: locationArb }),
);

/**
 * draft-ietf-moq-transport-21 §3.3.1:
 * フィルタ未指定は全 Object 通過。任意の Location で成り立つ。
 */
test("objectMatchesFilter: filter 未指定は任意の Location を通過する (PBT)", () => {
  fc.assert(
    fc.property(boundaryLocationArb, (objectLocation) => {
      assert.isTrue(objectMatchesFilter(objectLocation, undefined));
    }),
  );
});

/**
 * draft-ietf-moq-transport-21 §3.3.1:
 * "Start Location 以上" が通過条件である。Start より小さい Location は
 * 終端の内側でも不通過になる。
 */
test("objectMatchesFilter: Start より小さい Location は不通過 (PBT)", () => {
  fc.assert(
    fc.property(
      fc.oneof(
        absoluteStartArb,
        absoluteRangeArb,
        absoluteRangeWithEndObjectArb,
        relativeGroupFilterArb,
      ),
      largestLocationArb,
      (filter, largestLocation) => {
        const resolved = resolveFilter(filter as LocationFilter, largestLocation);
        assert.isDefined(resolved);
        const { start } = resolved!;
        // Start ちょうどは通過する
        assert.isTrue(objectMatchesFilter(start, resolved));
        // Start より小さい Location は不通過。Start が {0, 0} のときは
        // これより小さい Location が存在しない
        if (start.object > 0n) {
          assert.isFalse(
            objectMatchesFilter({ group: start.group, object: start.object - 1n }, resolved),
          );
        } else if (start.group > 0n) {
          assert.isFalse(objectMatchesFilter({ group: start.group - 1n, object: 0n }, resolved));
        }
      },
    ),
  );
});

/**
 * draft-ietf-moq-transport-21 §3.3.1:
 * End Group を持つフィルタは End Group より大きい Group を不通過にする。
 * End Object を持つ場合は End Group 内で End Object より大きい Object も不通過。
 */
test("objectMatchesFilter: End Group / End Object の外側は不通過 (PBT)", () => {
  fc.assert(
    fc.property(
      fc.oneof(absoluteRangeArb, absoluteRangeWithEndObjectArb),
      largestLocationArb,
      locationArb,
      (filter, largestLocation, offset) => {
        const resolved = resolveFilter(filter as LocationFilter, largestLocation);
        assert.isDefined(resolved);
        assert.isDefined(resolved!.endGroup);
        // End Group より大きい Group は不通過
        assert.isFalse(
          objectMatchesFilter(
            { group: resolved!.endGroup! + 1n + offset.group, object: offset.object },
            resolved,
          ),
        );
        if (resolved!.endObject !== undefined) {
          // End Group 内で End Object より大きい Object は不通過
          assert.isFalse(
            objectMatchesFilter(
              { group: resolved!.endGroup!, object: resolved!.endObject + 1n + offset.object },
              resolved,
            ),
          );
        }
      },
    ),
  );
});

/**
 * draft-ietf-moq-transport-21 §3.3.1:
 * 終端を持たないフィルタは Start 以降で単調である。通過した Location より
 * 大きい Location も必ず通過する (上限が無いため)。
 */
test("objectMatchesFilter: 終端なしフィルタは Start 以降で単調 (PBT)", () => {
  fc.assert(
    fc.property(
      noEndGroupFilterArb,
      locationArb,
      locationArb,
      ({ filter, largestLocation }, a, b) => {
        const resolved = resolveFilter(filter, largestLocation);
        assert.isDefined(resolved);
        assert.isUndefined(resolved!.endGroup);
        if (!objectMatchesFilter(a, resolved)) {
          return;
        }
        if (compareLocations(a, b) > 0) {
          return;
        }
        assert.isTrue(objectMatchesFilter(b, resolved));
      },
    ),
  );
});

/**
 * draft-ietf-moq-transport-21 §3.3.1:
 * Group が Start Group より大きければ、Object の値に関わらず通過する
 * (End Group がある場合は End Group まで)。
 */
test("objectMatchesFilter: Start Group より大きい Group は通過する (PBT)", () => {
  fc.assert(
    fc.property(
      fc.oneof(
        absoluteStartArb,
        absoluteRangeArb,
        absoluteRangeWithEndObjectArb,
        relativeGroupFilterArb,
      ),
      largestLocationArb,
      locationArb,
      (filter, largestLocation, offset) => {
        const resolved = resolveFilter(filter as LocationFilter, largestLocation);
        assert.isDefined(resolved);
        const group = resolved!.start.group + 1n + offset.group;
        if (resolved!.endGroup !== undefined && group > resolved!.endGroup) {
          return;
        }
        assert.isTrue(objectMatchesFilter({ group, object: 0n }, resolved));
      },
    ),
  );
});

/**
 * draft-ietf-moq-transport-21 §9.20.10:
 * "When EndObject is omitted, the filter includes all objects in the End Group."
 * End Object は End Group 内でのみ上限として働き、End Group より前の Group は
 * Object の値に関わらず通過する。
 */
test("objectMatchesFilter: End Object は End Group 内でのみ上限になる (PBT)", () => {
  fc.assert(
    fc.property(
      absoluteRangeWithEndObjectArb,
      largestLocationArb,
      locationArb,
      (filter, largestLocation, offset) => {
        const resolved = resolveFilter(filter as LocationFilter, largestLocation);
        assert.isDefined(resolved);
        assert.isDefined(resolved!.endGroup);
        const { start, endGroup, endObject } = resolved!;
        assert.isDefined(endObject);
        // End Group より前の Group は Object の値に関わらず通過する
        const beforeEndGroup = start.group + 1n + offset.group;
        if (beforeEndGroup >= endGroup!) {
          return;
        }
        assert.isTrue(
          objectMatchesFilter(
            { group: beforeEndGroup, object: endObject! + 1n + offset.object },
            resolved,
          ),
        );
      },
    ),
  );
});

// ============================================================================
// rangeFiltersMatch のテスト
// ============================================================================

/** 単一 Range (open-ended または閉区間) */
const filterRangeArb: fc.Arbitrary<FilterRange> = fc
  .record({
    start: fc.bigInt({ min: 0n, max: 100n }),
    delta: fc.option(fc.bigInt({ min: 0n, max: 20n }), { nil: undefined }),
  })
  .map(({ start, delta }) => (delta === undefined ? { start } : { start, end: start + delta }));

/** Range Filter の種別 */
const rangeFilterTypeArb = fc.constantFrom(
  "subgroup",
  "objectId",
  "priority",
  "objectProperty",
  "trackProperty",
) as fc.Arbitrary<RangeFilterSpec["type"]>;

/**
 * Range Filter 指定の arbitrary
 *
 * SetID は 0〜3 に絞り、可換性と結合則のテストで「既存 SetID」と
 * 「新規 SetID」を作り分けられるようにする。
 */
const rangeFilterSpecArb: fc.Arbitrary<RangeFilterSpec> = fc.oneof(
  rangeFilterTypeArb.map((type) => ({ type, remove: true }) as RangeFilterSpec),
  fc.record({
    type: rangeFilterTypeArb,
    setId: fc.integer({ min: 0, max: 3 }),
    propertyType: fc.constant(0n),
    ranges: fc.array(filterRangeArb, { minLength: 1, maxLength: 3 }),
  }) as fc.Arbitrary<RangeFilterSpec>,
);

/** Range Filter の評価値 */
const rangeFilterValuesArb: fc.Arbitrary<RangeFilterValues> = fc.record({
  subgroupId: fc.option(fc.bigInt({ min: 0n, max: 100n }), { nil: undefined }),
  objectId: fc.bigInt({ min: 0n, max: 100n }),
  publisherPriority: fc.option(fc.integer({ min: 0, max: 255 }), { nil: undefined }),
});

/**
 * draft-ietf-moq-transport-21 §3.3.2:
 * フィルタなし (空配列) と削除エントリのみは全通過。
 */
test("rangeFiltersMatch: フィルタなしと削除のみは全通過 (PBT)", () => {
  fc.assert(
    fc.property(
      rangeFilterValuesArb,
      fc.array(
        rangeFilterTypeArb.map((type) => ({ type, remove: true }) as RangeFilterSpec),
        {
          maxLength: 3,
        },
      ),
      (values, removes) => {
        assert.isTrue(rangeFiltersMatch([], values));
        assert.isTrue(rangeFiltersMatch(removes, values));
      },
    ),
  );
});

/**
 * draft-ietf-moq-transport-21 §3.3.2:
 * SetID ごとの AND / 異なる SetID 間の OR は順序に依存しない。
 */
test("rangeFiltersMatch: 指定の並び順を変えても結果が変わらない (PBT)", () => {
  fc.assert(
    fc.property(
      fc.array(rangeFilterSpecArb, { maxLength: 4 }),
      rangeFilterValuesArb,
      (specs, values) => {
        const expected = rangeFiltersMatch(specs, values);
        assert.equal(rangeFiltersMatch([...specs].reverse(), values), expected);
      },
    ),
  );
});

/**
 * draft-ietf-moq-transport-21 §3.3.2:
 * Length=0 の削除エントリは評価対象から除外されるため、加えても結果が変わらない。
 */
test("rangeFiltersMatch: 削除エントリを加えても結果が変わらない (PBT)", () => {
  fc.assert(
    fc.property(
      fc.array(rangeFilterSpecArb, { maxLength: 4 }),
      rangeFilterTypeArb,
      rangeFilterValuesArb,
      (specs, type, values) => {
        const expected = rangeFiltersMatch(specs, values);
        assert.equal(rangeFiltersMatch([...specs, { type, remove: true }], values), expected);
      },
    ),
  );
});

/**
 * draft-ietf-moq-transport-21 §3.3.2:
 * 同一 SetID は AND で結合するため、同じ SetID の指定を足しても
 * 不通過が通過に変わることはない (単調)。
 */
test("rangeFiltersMatch: 同一 SetID の追加で通過に変わらない (PBT)", () => {
  fc.assert(
    fc.property(
      fc.record({
        first: fc.record({
          type: rangeFilterTypeArb,
          setId: fc.integer({ min: 0, max: 3 }),
          propertyType: fc.constant(0n),
          ranges: fc.array(filterRangeArb, { minLength: 1, maxLength: 3 }),
        }),
        rest: fc.array(rangeFilterSpecArb, { maxLength: 3 }),
        extra: fc.record({
          type: rangeFilterTypeArb,
          propertyType: fc.constant(0n),
          ranges: fc.array(filterRangeArb, { minLength: 1, maxLength: 3 }),
        }),
      }),
      rangeFilterValuesArb,
      ({ first, rest, extra }, values) => {
        const specs: RangeFilterSpec[] = [first as RangeFilterSpec, ...rest];
        const extended: RangeFilterSpec[] = [
          ...specs,
          { ...extra, setId: first.setId } as RangeFilterSpec,
        ];
        if (rangeFiltersMatch(extended, values)) {
          assert.isTrue(rangeFiltersMatch(specs, values));
        }
      },
    ),
  );
});

/**
 * draft-ietf-moq-transport-21 §3.3.2:
 * 異なる SetID 間は OR で結合するため、新しい SetID の指定を足しても
 * 通過が不通過に変わることはない (単調)。
 */
test("rangeFiltersMatch: 新しい SetID の追加で不通過に変わらない (PBT)", () => {
  fc.assert(
    fc.property(
      fc.array(rangeFilterSpecArb, { maxLength: 4 }),
      fc.record({
        type: rangeFilterTypeArb,
        propertyType: fc.constant(0n),
        ranges: fc.array(filterRangeArb, { minLength: 1, maxLength: 3 }),
      }),
      rangeFilterValuesArb,
      (specs, extra, values) => {
        // 削除エントリしかない場合は「評価対象なし = 全通過」であり、
        // 実フィルタを足すと結果が変わり得るため単調性の対象外とする
        if (!specs.some((spec) => !("remove" in spec))) {
          return;
        }
        if (!rangeFiltersMatch(specs, values)) {
          return;
        }
        // SetID 99 は specs の生成範囲 (0〜3) と重ならないため必ず新しい SetID になる
        assert.isTrue(
          rangeFiltersMatch([...specs, { ...extra, setId: 99 } as RangeFilterSpec], values),
        );
      },
    ),
  );
});
