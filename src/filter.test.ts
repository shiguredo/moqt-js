/**
 * Location Filter マッチングの単体テスト
 * draft-ietf-moq-transport-19 Section 5.1.2 (Location Filter)
 */

import { test, assert } from "vite-plus/test";
import { resolveFilter, objectMatchesFilter } from "./filter";
import type { Location } from "./message/types";
import type { SubscriptionFilter } from "./message/parameter";

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
  const filter: SubscriptionFilter = {
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
  const filter: SubscriptionFilter = {
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
  const filter: SubscriptionFilter = {
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
  const filter: SubscriptionFilter = { type: "NextGroupStart" };
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
  const filter: SubscriptionFilter = { type: "NextGroupStart" };
  const result = resolveFilter(filter, null);
  assert.isDefined(result);
  assert.equal(result.start.group, 1n);
  assert.equal(result.start.object, 0n);
});

/**
 * LargestObject は LARGEST_OBJECT の Location をそのまま start にする。
 */
test("resolveFilter: LargestObject は LARGEST_OBJECT の Location を start にする", () => {
  const filter: SubscriptionFilter = { type: "LargestObject" };
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
  const filter: SubscriptionFilter = { type: "LargestObject" };
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
