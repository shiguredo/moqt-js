import { test, assert } from "vite-plus/test";
import type { MoqtObject } from "moqt-js";
import { sortByGroupObject } from "./useSubscriber";

function makeObject(groupId: bigint, objectId: bigint): MoqtObject {
  return {
    groupId,
    objectId,
    status: 0,
    payload: new Uint8Array(),
  };
}

test("sortByGroupObject returns a new array (non-destructive)", () => {
  const input: MoqtObject[] = [makeObject(2n, 0n), makeObject(1n, 0n)];
  const inputCopy = [...input];
  const result = sortByGroupObject(input);
  assert.notStrictEqual(result, input, "result must not be the same reference as input");
  assert.deepEqual(input, inputCopy, "input array must not be mutated");
});

test("sortByGroupObject sorts ascending by groupId", () => {
  const objects: MoqtObject[] = [makeObject(3n, 0n), makeObject(1n, 0n), makeObject(2n, 0n)];
  const result = sortByGroupObject(objects);
  assert.deepEqual(
    result.map((o) => o.groupId),
    [1n, 2n, 3n],
  );
});

test("sortByGroupObject sorts ascending by objectId within same groupId", () => {
  const objects: MoqtObject[] = [makeObject(1n, 2n), makeObject(1n, 0n), makeObject(1n, 1n)];
  const result = sortByGroupObject(objects);
  assert.deepEqual(
    result.map((o) => o.objectId),
    [0n, 1n, 2n],
  );
});

test("sortByGroupObject sorts by groupId first then objectId", () => {
  const objects: MoqtObject[] = [
    makeObject(2n, 1n),
    makeObject(1n, 2n),
    makeObject(2n, 0n),
    makeObject(1n, 1n),
  ];
  const result = sortByGroupObject(objects);
  assert.deepEqual(
    result.map((o) => [o.groupId, o.objectId]),
    [
      [1n, 1n],
      [1n, 2n],
      [2n, 0n],
      [2n, 1n],
    ],
  );
});

test("sortByGroupObject handles empty input", () => {
  const result = sortByGroupObject([]);
  assert.deepEqual(result, []);
});

test("sortByGroupObject handles single element input", () => {
  const only = makeObject(5n, 7n);
  const result = sortByGroupObject([only]);
  assert.equal(result.length, 1);
  assert.equal(result[0].groupId, 5n);
  assert.equal(result[0].objectId, 7n);
});

test("sortByGroupObject treats equal (groupId, objectId) as stable enough to not crash", () => {
  const a = makeObject(1n, 1n);
  const b = makeObject(1n, 1n);
  const result = sortByGroupObject([a, b]);
  assert.equal(result.length, 2);
  // どちらが先でも正しい。比較関数が 0 を返した場合の挙動は仕様で安定ソートが保証されるが、
  // ここでは「両要素が含まれること」のみを検証する。
  assert.ok(result.includes(a));
  assert.ok(result.includes(b));
});

test("sortByGroupObject handles BigInt boundary values", () => {
  const large = makeObject(2n ** 62n, 0n);
  const small = makeObject(0n, 0n);
  const result = sortByGroupObject([large, small]);
  assert.equal(result[0].groupId, 0n);
  assert.equal(result[1].groupId, 2n ** 62n);
});
