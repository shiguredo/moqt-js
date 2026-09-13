/**
 * Location Filter マッチングの単体テスト
 * draft-ietf-moq-transport-21 Section 3.3.1 (Location Filter)
 */

import { test, assert } from "vite-plus/test";
import { rangeFiltersMatch, trackPropertyFiltersMatch } from "./filter";
import type { RangeFilterSpec } from "./message/parameter";
import { encodeProperties, type Property } from "./properties";

// ============================================================================
// resolveFilter のテスト
//
// resolveFilter は「Filter 種別 × LARGEST_OBJECT の有無 × Location 値」の有限な
// 離散パターンを扱う純粋関数であるため、検証は src/filter.prop.ts の PBT に
// 集約している。ここには PBT で表せない意図的なエラー入力を置く。
// ============================================================================

// ============================================================================
// objectMatchesFilter のテスト
//
// objectMatchesFilter(resolveFilter(...)) の通過条件は、任意の Location に対する
// 単調性・境界として src/filter.prop.ts の PBT で検証している。
// ============================================================================

// ============================================================================
// rangeFiltersMatch のテスト
// draft-ietf-moq-transport-21 Section 3.3.2 (Range Filters)
// ============================================================================

/**
 * フィルタなし (空配列) は全通過。
 */
test("rangeFiltersMatch: フィルタなしは全通過", () => {
  assert.isTrue(rangeFiltersMatch([], { objectId: 0n }));
});

/**
 * draft-ietf-moq-transport-21 Section 8.6:
 * 「Each Range Filter is a sequence of Start/End (vi64) inclusive Range pairs」
 * 包含判定は両端含む (inclusive) ことを検証する。
 */
test("rangeFiltersMatch: 包含判定は両端含む (inclusive)", () => {
  const filters: RangeFilterSpec[] = [
    { type: "objectId", setId: 0, ranges: [{ start: 3n, end: 5n }] },
  ];
  assert.isTrue(rangeFiltersMatch(filters, { objectId: 3n }));
  assert.isTrue(rangeFiltersMatch(filters, { objectId: 4n }));
  assert.isTrue(rangeFiltersMatch(filters, { objectId: 5n }));
  assert.isFalse(rangeFiltersMatch(filters, { objectId: 2n }));
  assert.isFalse(rangeFiltersMatch(filters, { objectId: 6n }));
});

/**
 * draft-ietf-moq-transport-21 §8.6 の例:
 * ranges 3-5 / 10-15。objectId 4 は通過、objectId 7 は不通過。
 */
test("rangeFiltersMatch: §8.6 の例 (objectId 4 は通過 / 7 は不通過)", () => {
  const filters: RangeFilterSpec[] = [
    {
      type: "objectId",
      setId: 0,
      ranges: [
        { start: 3n, end: 5n },
        { start: 10n, end: 15n },
      ],
    },
  ];
  assert.isTrue(rangeFiltersMatch(filters, { objectId: 4n }));
  assert.isTrue(rangeFiltersMatch(filters, { objectId: 12n }));
  assert.isFalse(rangeFiltersMatch(filters, { objectId: 7n }));
});

/**
 * 終端省略 (End なし) は open-ended (上限なし)。
 */
test("rangeFiltersMatch: 終端省略は open-ended", () => {
  const filters: RangeFilterSpec[] = [{ type: "objectId", setId: 0, ranges: [{ start: 10n }] }];
  assert.isTrue(rangeFiltersMatch(filters, { objectId: 10n }));
  assert.isTrue(rangeFiltersMatch(filters, { objectId: 100n }));
  assert.isFalse(rangeFiltersMatch(filters, { objectId: 9n }));
});

/**
 * 同一 SetID のフィルタは AND、異なる SetID は OR で結合する。
 */
test("rangeFiltersMatch: 同一 SetID は AND、異なる SetID は OR", () => {
  // 同一 SetID: objectId 5-7 かつ subgroupId 1 でないと通過しない
  const andFilters: RangeFilterSpec[] = [
    { type: "objectId", setId: 0, ranges: [{ start: 5n, end: 7n }] },
    { type: "subgroup", setId: 0, ranges: [{ start: 1n, end: 1n }] },
  ];
  assert.isTrue(rangeFiltersMatch(andFilters, { subgroupId: 1n, objectId: 6n }));
  assert.isFalse(rangeFiltersMatch(andFilters, { subgroupId: 2n, objectId: 6n }));
  assert.isFalse(rangeFiltersMatch(andFilters, { subgroupId: 1n, objectId: 8n }));

  // 異なる SetID: どちらか一方が通れば通過
  const orFilters: RangeFilterSpec[] = [
    { type: "objectId", setId: 0, ranges: [{ start: 5n, end: 7n }] },
    { type: "objectId", setId: 1, ranges: [{ start: 20n, end: 22n }] },
  ];
  assert.isTrue(rangeFiltersMatch(orFilters, { objectId: 6n }));
  assert.isTrue(rangeFiltersMatch(orFilters, { objectId: 21n }));
  assert.isFalse(rangeFiltersMatch(orFilters, { objectId: 10n }));
});

/**
 * Length=0 の削除エントリは評価対象から除外する。
 */
test("rangeFiltersMatch: 削除エントリは評価対象から除外", () => {
  const filters: RangeFilterSpec[] = [
    { type: "objectId", remove: true },
    { type: "objectId", setId: 0, ranges: [{ start: 5n, end: 7n }] },
  ];
  assert.isTrue(rangeFiltersMatch(filters, { objectId: 6n }));
  assert.isFalse(rangeFiltersMatch(filters, { objectId: 10n }));
});

/**
 * 削除エントリのみの配列は全通過 (評価対象フィルタなし)。
 */
test("rangeFiltersMatch: 削除エントリのみは全通過", () => {
  assert.isTrue(rangeFiltersMatch([{ type: "objectId", remove: true }], { objectId: 5n }));
});

/**
 * subgroupId が明示されていないオブジェクトは SUBGROUP_FILTER で不通過。
 */
test("rangeFiltersMatch: subgroupId 未指定は SUBGROUP_FILTER で不通過", () => {
  const filters: RangeFilterSpec[] = [
    { type: "subgroup", setId: 0, ranges: [{ start: 0n, end: 10n }] },
  ];
  assert.isFalse(rangeFiltersMatch(filters, { objectId: 1n }));
  assert.isTrue(rangeFiltersMatch(filters, { subgroupId: 5n, objectId: 1n }));
});

/**
 * Publisher Priority が明示されていないオブジェクトは PRIORITY_FILTER で不通過
 * (publisherPriority = 0 は評価値として使わない)。
 */
test("rangeFiltersMatch: priority 未指定は PRIORITY_FILTER で不通過", () => {
  const filters: RangeFilterSpec[] = [
    { type: "priority", setId: 0, ranges: [{ start: 0n, end: 255n }] },
  ];
  assert.isFalse(rangeFiltersMatch(filters, { objectId: 1n }));
  assert.isTrue(rangeFiltersMatch(filters, { objectId: 1n, publisherPriority: 128 }));
});

/**
 * OBJECT_PROPERTY_FILTER: Object Properties から対象 Property Type の値を
 * 寛容デコードで抽出して評価する。
 */
test("rangeFiltersMatch: OBJECT_PROPERTY_FILTER は寛容デコードで評価する", () => {
  // OBJECT_DELIVERY_TIMEOUT (0x02, 偶数 ID, varint value) を含む Object Properties
  const properties = encodeProperties([
    { id: 0x02n, value: 100n },
    { id: 0x03n, data: new Uint8Array([1, 2, 3]) },
  ]);
  const filters: RangeFilterSpec[] = [
    {
      type: "objectProperty",
      setId: 0,
      propertyType: 0x02n,
      ranges: [{ start: 50n, end: 150n }],
    },
  ];
  assert.isTrue(rangeFiltersMatch(filters, { objectId: 1n, objectProperties: properties }));
  assert.isFalse(rangeFiltersMatch(filters, { objectId: 1n, objectProperties: new Uint8Array() }));
});

/**
 * OBJECT_PROPERTY_FILTER: 対象 Property ID が Object Properties にない場合は不通過。
 */
test("rangeFiltersMatch: OBJECT_PROPERTY_FILTER の対象 Property 不在は不通過", () => {
  const properties = encodeProperties([{ id: 0x04n, value: 100n }]);
  const filters: RangeFilterSpec[] = [
    {
      type: "objectProperty",
      setId: 0,
      propertyType: 0x02n,
      ranges: [{ start: 0n, end: 1000n }],
    },
  ];
  assert.isFalse(rangeFiltersMatch(filters, { objectId: 1n, objectProperties: properties }));
});

/**
 * OBJECT_PROPERTY_FILTER: IMMUTABLE_PROPERTIES (0x0B) のネスト内も検索する (§12.7)。
 */
test("rangeFiltersMatch: OBJECT_PROPERTY_FILTER は IMMUTABLE_PROPERTIES ネスト内も検索する", () => {
  // IMMUTABLE_PROPERTIES (0x0B) の data は body のみ (decodeProperties の出力形式)
  const properties = encodeProperties([
    { id: 0x0bn, data: encodeProperties([{ id: 0x02n, value: 100n }]) },
  ]);
  const filters: RangeFilterSpec[] = [
    {
      type: "objectProperty",
      setId: 0,
      propertyType: 0x02n,
      ranges: [{ start: 50n, end: 150n }],
    },
  ];
  assert.isTrue(rangeFiltersMatch(filters, { objectId: 1n, objectProperties: properties }));
});

/**
 * IMMUTABLE_PROPERTIES の再帰深さ上限を超えるネストは不通過になることを検証する。
 */
test("rangeFiltersMatch: IMMUTABLE_PROPERTIES の再帰深さ上限超過は不通過", () => {
  // 深さ 8 は通過する (上限ちょうど)。0x0b が 7 個 + 0x02 = 深さ 7 の 0x02
  let nested: Property[] = [{ id: 0x02n, value: 100n }];
  for (let i = 0; i < 7; i++) {
    nested = [{ id: 0x0bn, data: encodeProperties(nested) }];
  }
  const withinLimit = encodeProperties(nested);
  const filters: RangeFilterSpec[] = [
    {
      type: "objectProperty",
      setId: 0,
      propertyType: 0x02n,
      ranges: [{ start: 50n, end: 150n }],
    },
  ];
  assert.isTrue(rangeFiltersMatch(filters, { objectId: 1n, objectProperties: withinLimit }));

  // 深さ 9 (0x0b が 9 個 + 0x02、最内の 0x02 は depth 9 で到達) は上限超過で不通過
  let deepNested: Property[] = [{ id: 0x02n, value: 100n }];
  for (let i = 0; i < 9; i++) {
    deepNested = [{ id: 0x0bn, data: encodeProperties(deepNested) }];
  }
  const overLimit = encodeProperties(deepNested);
  assert.isFalse(rangeFiltersMatch(filters, { objectId: 1n, objectProperties: overLimit }));

  // 深さ 10 (0x0b が 10 個 + 0x02) も上限超過で不通過
  let deeperNested: Property[] = [{ id: 0x02n, value: 100n }];
  for (let i = 0; i < 10; i++) {
    deeperNested = [{ id: 0x0bn, data: encodeProperties(deeperNested) }];
  }
  const farOverLimit = encodeProperties(deeperNested);
  assert.isFalse(rangeFiltersMatch(filters, { objectId: 1n, objectProperties: farOverLimit }));
});

// ============================================================================
// trackPropertyFiltersMatch のテスト
// draft-ietf-moq-transport-21 Section 3.3.2 (TRACK_PROPERTY_FILTER)
// ============================================================================

/**
 * TRACK_PROPERTY_FILTER: 受信 PUBLISH の Track Properties を検索して評価する。
 */
test("trackPropertyFiltersMatch: Track Properties を検索して評価する", () => {
  const trackProperties: Property[] = [{ id: 0x30n, value: 7n }];
  const filters: RangeFilterSpec[] = [
    {
      type: "trackProperty",
      setId: 0,
      propertyType: 0x30n,
      ranges: [{ start: 1n, end: 10n }],
    },
  ];
  assert.isTrue(trackPropertyFiltersMatch(filters, trackProperties));
  assert.isFalse(trackPropertyFiltersMatch(filters, []));
});

/**
 * TRACK_PROPERTY_FILTER が指定されていない場合は全通過。
 */
test("trackPropertyFiltersMatch: 0x29 未指定は全通過", () => {
  const filters: RangeFilterSpec[] = [
    { type: "subgroup", setId: 0, ranges: [{ start: 0n, end: 10n }] },
  ];
  assert.isTrue(trackPropertyFiltersMatch(filters, []));
});

/**
 * TRACK_PROPERTY_FILTER: IMMUTABLE_PROPERTIES のネスト内も検索する (§12.7)。
 */
test("trackPropertyFiltersMatch: IMMUTABLE_PROPERTIES ネスト内も検索する", () => {
  // IMMUTABLE_PROPERTIES (0x0B) の data は body のみ (decodeProperties の出力形式)
  const trackProperties: Property[] = [
    { id: 0x0bn, data: encodeProperties([{ id: 0x30n, value: 7n }]) },
  ];
  const filters: RangeFilterSpec[] = [
    {
      type: "trackProperty",
      setId: 0,
      propertyType: 0x30n,
      ranges: [{ start: 1n, end: 10n }],
    },
  ];
  assert.isTrue(trackPropertyFiltersMatch(filters, trackProperties));
});
