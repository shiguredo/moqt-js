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
import { resolveFilter } from "./filter";
import type { Location } from "./message/types";
import { locationFilterArb } from "./message/parameterArb";
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
  .filter((filter) => filter.startGroup !== 0n || filter.startObject !== 0n);

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
