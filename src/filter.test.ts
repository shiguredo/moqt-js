/**
 * Location Filter マッチングの単体テスト
 * draft-ietf-moq-transport-19 Section 5.1.2 (Location Filter)
 */

import { test, assert } from "vite-plus/test";
import {
  resolveFilter,
  objectMatchesFilter,
  evaluateRangeFilters,
  mergeRangeFilters,
  evaluateTrackPropertyFilters,
} from "./filter";
import type { Location } from "./message/types";
import type { LocationFilter, RangeFilterSpec } from "./message/parameter";
import { encodeVarint } from "./varint";

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
 * LARGEST_OBJECT 未受信時は {0, 0} から開始するため Group 1 になる。
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
 * NextGroupStart で LARGEST_OBJECT 未受信時は {1, 0}。
 */
test("resolveFilter: NextGroupStart で LARGEST_OBJECT 未受信時は Group 1", () => {
  const filter: LocationFilter = { type: "NextGroupStart" };
  const result = resolveFilter(filter, null);
  assert.isDefined(result);
  assert.equal(result.start.group, 1n);
  assert.equal(result.start.object, 0n);
});

/**
 * LargestObject は LARGEST_OBJECT の Location をそのまま start にする。
 */
test("resolveFilter: LargestObject は LARGEST_OBJECT の Location を start にする", () => {
  const filter: LocationFilter = { type: "LargestObject" };
  const result = resolveFilter(filter, { group: 7n, object: 2n });
  assert.isDefined(result);
  assert.equal(result.start.group, 7n);
  assert.equal(result.start.object, 2n);
  assert.isUndefined(result.endGroup);
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
// evaluateRangeFilters のテスト
// draft-ietf-moq-transport-19 Section 5.1.3 (Range Filters)
// ============================================================================

/**
 * §5.1.3 の例 (ranges 3-5 / 10-15): objectId 4 は通過、7 は不通過。
 * 両端を含む (inclusive)。
 */
test("evaluateRangeFilters: §5.1.3 の例 (3-5 / 10-15) で objectId 4 は通過 7 は不通過", () => {
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
  assert.isTrue(evaluateRangeFilters(filters, { objectId: 4n }));
  assert.isTrue(evaluateRangeFilters(filters, { objectId: 3n }));
  assert.isTrue(evaluateRangeFilters(filters, { objectId: 5n }));
  assert.isTrue(evaluateRangeFilters(filters, { objectId: 10n }));
  assert.isTrue(evaluateRangeFilters(filters, { objectId: 15n }));
  assert.isFalse(evaluateRangeFilters(filters, { objectId: 7n }));
  assert.isFalse(evaluateRangeFilters(filters, { objectId: 2n }));
  assert.isFalse(evaluateRangeFilters(filters, { objectId: 16n }));
});

/**
 * 終端省略 (End なし) は open-ended (上限なし)。
 */
test("evaluateRangeFilters: 終端省略は open-ended", () => {
  const filters: RangeFilterSpec[] = [{ type: "objectId", setId: 0, ranges: [{ start: 10n }] }];
  assert.isTrue(evaluateRangeFilters(filters, { objectId: 10n }));
  assert.isTrue(evaluateRangeFilters(filters, { objectId: 100n }));
  assert.isFalse(evaluateRangeFilters(filters, { objectId: 9n }));
});

/**
 * フィルタなし (undefined / 空配列) は全通過。
 */
test("evaluateRangeFilters: フィルタなしは全通過", () => {
  assert.isTrue(evaluateRangeFilters(undefined, { objectId: 0n }));
  assert.isTrue(evaluateRangeFilters([], { objectId: 0n }));
});

/**
 * 削除エントリ (remove: true) は評価対象から除外される。
 */
test("evaluateRangeFilters: 削除エントリは評価対象から除外", () => {
  const filters: RangeFilterSpec[] = [
    { type: "objectId", remove: true },
    { type: "subgroup", setId: 0, ranges: [{ start: 0n, end: 5n }] },
  ];
  assert.isTrue(evaluateRangeFilters(filters, { objectId: 999n, subgroupId: 3n }));
  assert.isFalse(evaluateRangeFilters(filters, { objectId: 999n, subgroupId: 7n }));
});

/**
 * 同一 SetID は AND、異なる SetID の結果は OR。
 * SetID 0: objectId 3-5 のみ、SetID 1: objectId 10-15 のみ。
 */
test("evaluateRangeFilters: 同一 SetID は AND、異 SetID は OR", () => {
  const filters: RangeFilterSpec[] = [
    { type: "objectId", setId: 0, ranges: [{ start: 3n, end: 5n }] },
    { type: "objectId", setId: 0, ranges: [{ start: 6n, end: 8n }] },
    { type: "objectId", setId: 1, ranges: [{ start: 10n, end: 15n }] },
  ];
  // SetID 0 は AND: 3-5 かつ 6-8 は空集合 → 不通過
  assert.isFalse(evaluateRangeFilters(filters, { objectId: 4n }));
  // SetID 1 は 10-15 → 通過
  assert.isTrue(evaluateRangeFilters(filters, { objectId: 12n }));
  // SetID 0 の AND は objectId が両方に含まれることはない
  assert.isFalse(evaluateRangeFilters(filters, { objectId: 7n }));
});

/**
 * TRACK_PROPERTY_FILTER とオブジェクトフィルタが異なる SetID の場合は、
 * SetID 単位の AND / SetID 間 OR の結合規則が種別をまたいで適用される。
 * track 不通過 (SetID 0) でも、オブジェクトフィルタを満たす SetID 1 が
 * あれば通過する。
 */
test("evaluateRangeFilters: track 不通過の SetID でもオブジェクトフィルタの SetID で通過できる", () => {
  const filters: RangeFilterSpec[] = [
    { type: "objectId", setId: 1, ranges: [{ start: 3n, end: 5n }] },
  ];
  // SetID 0 の track 評価は不通過、SetID 1 は objectId 3-5 のみ
  const trackResults = new Map<number, boolean>([
    [0, false],
    [1, true],
  ]);
  // SetID 0 (track 不通過) と SetID 1 (objectId 3-5) の OR → objectId 4 は通過
  assert.isTrue(evaluateRangeFilters(filters, { objectId: 4n }, trackResults));
  // objectId 7 は SetID 1 の範囲外 → 不通過
  assert.isFalse(evaluateRangeFilters(filters, { objectId: 7n }, trackResults));
});

/**
 * TRACK_PROPERTY_FILTER とオブジェクトフィルタが同じ SetID の場合は AND 結合。
 * track 不通過の SetID はオブジェクトフィルタが通過しても不通過。
 */
test("evaluateRangeFilters: track 不通過の SetID はオブジェクトフィルタと AND で不通過", () => {
  const filters: RangeFilterSpec[] = [
    { type: "objectId", setId: 0, ranges: [{ start: 3n, end: 5n }] },
  ];
  // SetID 0 の track 評価は不通過
  const trackResults = new Map<number, boolean>([[0, false]]);
  // objectId 4 はオブジェクトフィルタを満たすが、同一 SetID の track が
  // 不通過のため AND で不通過
  assert.isFalse(evaluateRangeFilters(filters, { objectId: 4n }, trackResults));
});

/**
 * TRACK_PROPERTY_FILTER のみ (オブジェクトフィルタなし) で track 通過の
 * SetID があれば全通過する。
 */
test("evaluateRangeFilters: track 通過のみでオブジェクトフィルタなしは全通過", () => {
  // オブジェクトフィルタなし
  const trackResults = new Map<number, boolean>([[0, true]]);
  assert.isTrue(evaluateRangeFilters([], { objectId: 0n }, trackResults));
  // 全 SetID で track 不通過の場合は不通過
  const trackResultsAllFalse = new Map<number, boolean>([[0, false]]);
  assert.isFalse(evaluateRangeFilters([], { objectId: 0n }, trackResultsAllFalse));
});

/**
 * SUBGROUP_FILTER: subgroupId が明示されていない (datagram 経路) は不通過。
 */
test("evaluateRangeFilters: subgroupId が無いオブジェクトは不通過", () => {
  const filters: RangeFilterSpec[] = [
    { type: "subgroup", setId: 0, ranges: [{ start: 0n, end: 5n }] },
  ];
  assert.isTrue(evaluateRangeFilters(filters, { objectId: 0n, subgroupId: 3n }));
  assert.isFalse(evaluateRangeFilters(filters, { objectId: 0n, subgroupId: undefined }));
});

/**
 * PRIORITY_FILTER: publisherPriority が明示されていないオブジェクトは不通過。
 * datagram のデフォルト値 (0) も明示値として扱わない (evaluateRangeFilters は
 * 渡された値のみで評価する)。
 */
test("evaluateRangeFilters: publisherPriority が無いオブジェクトは不通過", () => {
  const filters: RangeFilterSpec[] = [
    { type: "priority", setId: 0, ranges: [{ start: 0n, end: 0n }] },
  ];
  assert.isTrue(evaluateRangeFilters(filters, { objectId: 0n, publisherPriority: 0 }));
  assert.isFalse(evaluateRangeFilters(filters, { objectId: 0n, publisherPriority: undefined }));
});

/**
 * PRIORITY_FILTER: 明示値が Range 外の場合は不通過。
 */
test("evaluateRangeFilters: publisherPriority が Range 外なら不通過", () => {
  const filters: RangeFilterSpec[] = [
    { type: "priority", setId: 0, ranges: [{ start: 5n, end: 10n }] },
  ];
  assert.isTrue(evaluateRangeFilters(filters, { objectId: 0n, publisherPriority: 7 }));
  assert.isFalse(evaluateRangeFilters(filters, { objectId: 0n, publisherPriority: 0 }));
  assert.isFalse(evaluateRangeFilters(filters, { objectId: 0n, publisherPriority: 11 }));
});

/**
 * OBJECT_PROPERTY_FILTER: 対象 Property の値が Range に含まれるかで評価する。
 * 寛容デコードで読めた分を使用する。
 */
test("evaluateRangeFilters: OBJECT_PROPERTY_FILTER は Property 値で評価する", () => {
  const filters: RangeFilterSpec[] = [
    { type: "objectProperty", setId: 0, propertyType: 0x02n, ranges: [{ start: 100n, end: 200n }] },
  ];
  // Object Properties バイト列: ID 0x02 (偶数、varint value) = 150
  // Key-Value-Pairs: delta Type = 0x02, value = 150
  const properties = encodeObjectPropertyVarint(0x02n, 150n);
  assert.isTrue(evaluateRangeFilters(filters, { objectId: 0n, objectProperties: properties }));
  const propertiesLow = encodeObjectPropertyVarint(0x02n, 50n);
  assert.isFalse(evaluateRangeFilters(filters, { objectId: 0n, objectProperties: propertiesLow }));
});

/**
 * OBJECT_PROPERTY_FILTER: Object Properties が無い / 対象 Property 不在は不通過。
 */
test("evaluateRangeFilters: OBJECT_PROPERTY_FILTER は Property 不在で不通過", () => {
  const filters: RangeFilterSpec[] = [
    { type: "objectProperty", setId: 0, propertyType: 0x02n, ranges: [{ start: 0n }] },
  ];
  assert.isFalse(evaluateRangeFilters(filters, { objectId: 0n }));
  assert.isFalse(
    evaluateRangeFilters(filters, { objectId: 0n, objectProperties: new Uint8Array(0) }),
  );
  // 別 Property ID のみ存在する場合は対象 Property 不在として不通過
  const other = encodeObjectPropertyVarint(0x06n, 10n);
  assert.isFalse(evaluateRangeFilters(filters, { objectId: 0n, objectProperties: other }));
});

/** 偶数 Property ID の Object Properties バイト列 (delta 0 から) を生成する */
function encodeObjectPropertyVarint(id: bigint, value: bigint): Uint8Array {
  return new Uint8Array([...encodeVarint(id), ...encodeVarint(value)]);
}

/**
 * OBJECT_PROPERTY_FILTER: 寛容デコード経路。
 * 途中で途切れた varint / 不正バイト列でも throw せず、読めた分のみで評価する
 * (対象 Property が読めなければ不通過)。
 */
test("evaluateRangeFilters: OBJECT_PROPERTY_FILTER は不正バイト列でも throw しない", () => {
  const filters: RangeFilterSpec[] = [
    { type: "objectProperty", setId: 0, propertyType: 0x02n, ranges: [{ start: 100n, end: 200n }] },
  ];
  // 途中で途切れた varint (0x80 で終端)
  const truncated = new Uint8Array([0x02, 0x80]);
  assert.isFalse(evaluateRangeFilters(filters, { objectId: 0n, objectProperties: truncated }));
  // 先頭バイトだけの不完全データ
  const single = new Uint8Array([0x02]);
  assert.isFalse(evaluateRangeFilters(filters, { objectId: 0n, objectProperties: single }));
});

/**
 * OBJECT_PROPERTY_FILTER: §12.7 の IMMUTABLE_PROPERTIES (0x0B) ネスト内も検索する。
 * ネスト内は寛容デコード (decodeObjectPropertiesTolerant) で検索する。
 */
test("evaluateRangeFilters: OBJECT_PROPERTY_FILTER は IMMUTABLE_PROPERTIES ネスト内も検索する", () => {
  const filters: RangeFilterSpec[] = [
    { type: "objectProperty", setId: 0, propertyType: 0x02n, ranges: [{ start: 100n, end: 200n }] },
  ];
  // IMMUTABLE_PROPERTIES (0x0B、奇数 ID = length + bytes) の data にネストした KVP を含める
  const inner = encodeObjectPropertyVarint(0x02n, 150n);
  const outer = new Uint8Array([
    ...encodeVarint(0x0bn),
    ...encodeVarint(BigInt(inner.length)),
    ...inner,
  ]);
  assert.isTrue(evaluateRangeFilters(filters, { objectId: 0n, objectProperties: outer }));
});

// ============================================================================
// evaluateTrackPropertyFilters のテスト
// draft-ietf-moq-transport-19 §5.1.3 (Track Property Filter)
// ============================================================================

test("evaluateTrackPropertyFilters: TRACK_PROPERTY_FILTER が無い場合は全通過", () => {
  assert.isTrue(evaluateTrackPropertyFilters(undefined, []));
  assert.isTrue(
    evaluateTrackPropertyFilters([{ type: "objectId", setId: 0, ranges: [{ start: 0n }] }], []),
  );
});

test("evaluateTrackPropertyFilters: Track Property 値が Range 内なら通過", () => {
  const filters: RangeFilterSpec[] = [
    { type: "trackProperty", setId: 0, propertyType: 0x30n, ranges: [{ start: 1n, end: 1n }] },
  ];
  assert.isTrue(evaluateTrackPropertyFilters(filters, [{ id: 0x30n, value: 1n }]));
  assert.isFalse(evaluateTrackPropertyFilters(filters, [{ id: 0x30n, value: 0n }]));
  // 対象 Property 不在は不通過
  assert.isFalse(evaluateTrackPropertyFilters(filters, [{ id: 0x02n, value: 1n }]));
});

/**
 * §12.7: IMMUTABLE_PROPERTIES ネスト内も検索する。
 */
test("evaluateTrackPropertyFilters: IMMUTABLE_PROPERTIES ネスト内も検索する", () => {
  const filters: RangeFilterSpec[] = [
    { type: "trackProperty", setId: 0, propertyType: 0x30n, ranges: [{ start: 1n, end: 1n }] },
  ];
  // IMMUTABLE_PROPERTIES (0x0B) の data はネストした KVP バイト列 (0x30 = 1)
  const inner = new Uint8Array([...encodeVarint(0x30n), ...encodeVarint(1n)]);
  assert.isTrue(evaluateTrackPropertyFilters(filters, [{ id: 0x0bn, data: inner }]));
});

// ============================================================================
// mergeRangeFilters のテスト
// draft-ietf-moq-transport-19 §5.1.3 (REQUEST_UPDATE の削除・置換・不変)
// ============================================================================

test("mergeRangeFilters: update が undefined / 空なら不変", () => {
  const current: RangeFilterSpec[] = [{ type: "objectId", setId: 0, ranges: [{ start: 0n }] }];
  assert.deepEqual(mergeRangeFilters(current, undefined), current);
  assert.deepEqual(mergeRangeFilters(current, []), current);
});

test("mergeRangeFilters: 新規フィルタは追加される", () => {
  const result = mergeRangeFilters(undefined, [
    { type: "objectId", setId: 0, ranges: [{ start: 0n, end: 5n }] },
  ]);
  assert.deepEqual(result, [{ type: "objectId", setId: 0, ranges: [{ start: 0n, end: 5n }] }]);
});

test("mergeRangeFilters: 同一 Parameter Type は全 SetID ごと置換される", () => {
  const current: RangeFilterSpec[] = [
    { type: "objectId", setId: 0, ranges: [{ start: 0n, end: 5n }] },
    { type: "objectId", setId: 1, ranges: [{ start: 10n, end: 15n }] },
    { type: "subgroup", setId: 1, ranges: [{ start: 0n }] },
  ];
  const result = mergeRangeFilters(current, [
    { type: "objectId", setId: 0, ranges: [{ start: 10n, end: 20n }] },
  ]);
  assert.deepEqual(result, [
    { type: "subgroup", setId: 1, ranges: [{ start: 0n }] },
    { type: "objectId", setId: 0, ranges: [{ start: 10n, end: 20n }] },
  ]);
});

test("mergeRangeFilters: 同一 update 内の複数インスタンスは置換後の新しい状態として追加される", () => {
  const current: RangeFilterSpec[] = [
    { type: "objectId", setId: 0, ranges: [{ start: 0n, end: 5n }] },
    { type: "objectId", setId: 1, ranges: [{ start: 10n, end: 15n }] },
    { type: "objectId", setId: 2, ranges: [{ start: 20n, end: 25n }] },
  ];
  const result = mergeRangeFilters(current, [
    { type: "objectId", setId: 0, ranges: [{ start: 3n, end: 4n }] },
    { type: "objectId", setId: 1, ranges: [{ start: 11n, end: 12n }] },
  ]);
  assert.deepEqual(result, [
    { type: "objectId", setId: 0, ranges: [{ start: 3n, end: 4n }] },
    { type: "objectId", setId: 1, ranges: [{ start: 11n, end: 12n }] },
  ]);
});

test("mergeRangeFilters: remove は Parameter Type 単位で削除される", () => {
  const current: RangeFilterSpec[] = [
    { type: "objectId", setId: 0, ranges: [{ start: 0n, end: 5n }] },
    { type: "objectId", setId: 1, ranges: [{ start: 10n }] },
    { type: "subgroup", setId: 0, ranges: [{ start: 0n }] },
  ];
  const result = mergeRangeFilters(current, [{ type: "objectId", remove: true }]);
  assert.deepEqual(result, [{ type: "subgroup", setId: 0, ranges: [{ start: 0n }] }]);
});

test("mergeRangeFilters: current が undefined でも remove は空を返す", () => {
  const result = mergeRangeFilters(undefined, [{ type: "objectId", remove: true }]);
  assert.deepEqual(result, []);
});

test("mergeRangeFilters: 同一 update 内で remove と置換が混在する場合は remove が先に適用される", () => {
  // 先に remove で objectId を全削除し、その後置換で追加される
  const current: RangeFilterSpec[] = [
    { type: "objectId", setId: 0, ranges: [{ start: 0n, end: 5n }] },
    { type: "objectId", setId: 1, ranges: [{ start: 10n }] },
  ];
  const result = mergeRangeFilters(current, [
    { type: "objectId", remove: true },
    { type: "objectId", setId: 0, ranges: [{ start: 100n, end: 200n }] },
  ]);
  assert.deepEqual(result, [{ type: "objectId", setId: 0, ranges: [{ start: 100n, end: 200n }] }]);
});

test("mergeRangeFilters: 置換は対象外の Parameter Type に影響しない", () => {
  const current: RangeFilterSpec[] = [
    { type: "objectId", setId: 0, ranges: [{ start: 0n, end: 5n }] },
    { type: "subgroup", setId: 1, ranges: [{ start: 0n }] },
  ];
  const result = mergeRangeFilters(current, [
    { type: "priority", setId: 2, ranges: [{ start: 10n, end: 20n }] },
  ]);
  assert.deepEqual(result, [
    { type: "objectId", setId: 0, ranges: [{ start: 0n, end: 5n }] },
    { type: "subgroup", setId: 1, ranges: [{ start: 0n }] },
    { type: "priority", setId: 2, ranges: [{ start: 10n, end: 20n }] },
  ]);
});
