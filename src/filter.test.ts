/**
 * Location Filter マッチングの単体テスト
 * draft-ietf-moq-transport-19 Section 5.1.2 (Location Filter)
 */

import { test, assert } from "vite-plus/test";
import {
  resolveFilter,
  objectMatchesFilter,
  rangeFiltersMatch,
  trackPropertyFiltersMatch,
} from "./filter";
import type { Location } from "./message/types";
import type { LocationFilter, RangeFilterSpec } from "./message/parameter";
import { encodeProperties, type Property } from "./properties";

// ============================================================================
// resolveFilter のテスト
// ============================================================================

/**
 * filter 省略時は undefined を返す（全 Object 通過）。
 */
test("resolveFilter: filter 省略時は undefined", () => {
  const result = resolveFilter(undefined, null);
  assert.isUndefined(result);
});

/**
 * AbsoluteStart は指定された Location をそのまま start にする。
 */
test("resolveFilter: AbsoluteStart は指定 Location を start にする", () => {
  const filter: LocationFilter = {
    type: "AbsoluteStart",
    startLocation: { group: 5n, object: 3n },
  };
  const result = resolveFilter(filter, null);
  assert.isDefined(result);
  assert.equal(result.start.group, 5n);
  assert.equal(result.start.object, 3n);
  assert.isUndefined(result.endGroup);
});

/**
 * AbsoluteRange は End Group = Start.Group + EndGroupDelta。
 * Delta = 0 は当該 Group のみが対象。
 */
test("resolveFilter: AbsoluteRange の End Group は Start.Group + Delta", () => {
  const filter: LocationFilter = {
    type: "AbsoluteRange",
    startLocation: { group: 5n, object: 0n },
    endGroupDelta: 3n,
  };
  const result = resolveFilter(filter, null);
  assert.isDefined(result);
  assert.equal(result.start.group, 5n);
  assert.equal(result.endGroup, 8n);
});

/**
 * AbsoluteRange で Delta = 0 は当該 Group のみ。
 */
test("resolveFilter: AbsoluteRange で Delta 0 は当該 Group のみ", () => {
  const filter: LocationFilter = {
    type: "AbsoluteRange",
    startLocation: { group: 5n, object: 2n },
    endGroupDelta: 0n,
  };
  const result = resolveFilter(filter, null);
  assert.isDefined(result);
  assert.equal(result.endGroup, 5n);
});

/**
 * NextGroupStart は LARGEST_OBJECT の Group + 1 から開始。
 * LARGEST_OBJECT 未受信（コンテンツ未配信）時は {0, 0} から開始する。
 */
test("resolveFilter: NextGroupStart は LARGEST_OBJECT の Group + 1", () => {
  const filter: LocationFilter = { type: "NextGroupStart" };
  const result = resolveFilter(filter, { group: 10n, object: 5n });
  assert.isDefined(result);
  assert.equal(result.start.group, 11n);
  assert.equal(result.start.object, 0n);
  assert.isUndefined(result.endGroup);
});

/**
 * NextGroupStart で LARGEST_OBJECT 未受信時（コンテンツ未配信）は {0, 0} から開始する。
 */
test("resolveFilter: NextGroupStart で LARGEST_OBJECT 未受信時は {0, 0}", () => {
  const filter: LocationFilter = { type: "NextGroupStart" };
  const result = resolveFilter(filter, null);
  assert.isDefined(result);
  assert.equal(result.start.group, 0n);
  assert.equal(result.start.object, 0n);
});

/**
 * LargestObject は LARGEST_OBJECT の次のオブジェクト（{Group, Object + 1}）から開始する。
 */
test("resolveFilter: LargestObject は LARGEST_OBJECT の次のオブジェクトから開始", () => {
  const filter: LocationFilter = { type: "LargestObject" };
  const result = resolveFilter(filter, { group: 7n, object: 2n });
  assert.isDefined(result);
  assert.equal(result.start.group, 7n);
  assert.equal(result.start.object, 3n);
  assert.isUndefined(result.endGroup);
});

/**
 * LargestObject で LARGEST_OBJECT = {0, 0} 配信済み時は {0, 1} から開始する。
 */
test("resolveFilter: LargestObject で LARGEST_OBJECT {0, 0} 時は {0, 1}", () => {
  const filter: LocationFilter = { type: "LargestObject" };
  const result = resolveFilter(filter, { group: 0n, object: 0n });
  assert.isDefined(result);
  assert.equal(result.start.group, 0n);
  assert.equal(result.start.object, 1n);
});

/**
 * NextGroupStart で LARGEST_OBJECT = {0, 0} のときは {1, 0} から開始する。
 * 未配信時 = {0, 0} と start が隣接する境界であり、未配信判定を値 ({0, 0}) で
 * 書く誤りを検出できる。
 */
test("resolveFilter: NextGroupStart で LARGEST_OBJECT {0, 0} 時は {1, 0}", () => {
  const filter: LocationFilter = { type: "NextGroupStart" };
  const result = resolveFilter(filter, { group: 0n, object: 0n });
  assert.isDefined(result);
  assert.equal(result.start.group, 1n);
  assert.equal(result.start.object, 0n);
});

/**
 * LargestObject で LARGEST_OBJECT 未受信時は {0, 0}。
 */
test("resolveFilter: LargestObject で LARGEST_OBJECT 未受信時は {0, 0}", () => {
  const filter: LocationFilter = { type: "LargestObject" };
  const result = resolveFilter(filter, null);
  assert.isDefined(result);
  assert.equal(result.start.group, 0n);
  assert.equal(result.start.object, 0n);
});

// ============================================================================
// objectMatchesFilter のテスト
// ============================================================================

/**
 * filter undefined は全 Object 通過。
 */
test("objectMatchesFilter: filter なしは全 Object 通過", () => {
  const loc: Location = { group: 0n, object: 0n };
  assert.isTrue(objectMatchesFilter(loc, undefined));
});

/**
 * Object Location >= Start で通過。
 */
test("objectMatchesFilter: Start 以上の Object は通過", () => {
  const filter = { start: { group: 5n, object: 3n }, endGroup: undefined };
  // 同一 Group で Object が大きい
  assert.isTrue(objectMatchesFilter({ group: 5n, object: 3n }, filter));
  assert.isTrue(objectMatchesFilter({ group: 5n, object: 4n }, filter));
  // 後の Group
  assert.isTrue(objectMatchesFilter({ group: 6n, object: 0n }, filter));
});

/**
 * Object Location < Start で不通過。
 */
test("objectMatchesFilter: Start 未満の Object は不通過", () => {
  const filter = { start: { group: 5n, object: 3n }, endGroup: undefined };
  // 前の Group
  assert.isFalse(objectMatchesFilter({ group: 4n, object: 100n }, filter));
  // 同一 Group で Object が小さい
  assert.isFalse(objectMatchesFilter({ group: 5n, object: 2n }, filter));
});

/**
 * End Group があるとき、Object Group > End Group は不通過。
 */
test("objectMatchesFilter: End Group 超過は不通過", () => {
  const filter = { start: { group: 5n, object: 0n }, endGroup: 8n };
  // End Group 以内
  assert.isTrue(objectMatchesFilter({ group: 8n, object: 100n }, filter));
  // End Group 超過
  assert.isFalse(objectMatchesFilter({ group: 9n, object: 0n }, filter));
});

/**
 * End Group があるとき、Start 未満かつ End Group 以内でも不通過。
 */
test("objectMatchesFilter: Start 未満は End Group 以内でも不通過", () => {
  const filter = { start: { group: 5n, object: 3n }, endGroup: 8n };
  assert.isFalse(objectMatchesFilter({ group: 5n, object: 2n }, filter));
  assert.isFalse(objectMatchesFilter({ group: 4n, object: 0n }, filter));
});

/**
 * End Group = Start.Group（Delta 0）は当該 Group の Start 以上のみ通過。
 */
test("objectMatchesFilter: End Group = Start.Group は当該 Group のみ", () => {
  const filter = { start: { group: 5n, object: 2n }, endGroup: 5n };
  assert.isTrue(objectMatchesFilter({ group: 5n, object: 2n }, filter));
  assert.isTrue(objectMatchesFilter({ group: 5n, object: 10n }, filter));
  assert.isFalse(objectMatchesFilter({ group: 6n, object: 0n }, filter));
  assert.isFalse(objectMatchesFilter({ group: 5n, object: 1n }, filter));
});

// ============================================================================
// rangeFiltersMatch のテスト
// draft-ietf-moq-transport-19 Section 5.1.3 (Range Filters)
// ============================================================================

/**
 * フィルタなし (空配列) は全通過。
 */
test("rangeFiltersMatch: フィルタなしは全通過", () => {
  assert.isTrue(rangeFiltersMatch([], { objectId: 0n }));
});

/**
 * draft-ietf-moq-transport-19 Section 5.1.3:
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
 * draft-ietf-moq-transport-19 §5.1.3 の例:
 * ranges 3-5 / 10-15。objectId 4 は通過、objectId 7 は不通過。
 */
test("rangeFiltersMatch: §5.1.3 の例 (objectId 4 は通過 / 7 は不通過)", () => {
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
// draft-ietf-moq-transport-19 Section 5.1.3 (TRACK_PROPERTY_FILTER)
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
