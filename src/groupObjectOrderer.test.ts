/**
 * GroupObjectOrderer のテスト
 *
 * draft-02 §4.1.1 の object モードでは Object ごとに Subgroup が分かれ、Group 内の
 * 到着順が保証されない。§6.2 が Group 内の Object ID を 0 から 1 ずつ増やすと定めるため、
 * 到着順ではなく Object ID 順に取り出すことを固定する。
 */

import { test, assert } from "vite-plus/test";
import { GroupObjectOrderer } from "./groupObjectOrderer";
import type { MoqtObject } from "./dataStream";

/** テスト用の Object を作る (payload と status は並べ替えに関係しない) */
function makeObject(groupId: bigint, objectId: bigint): MoqtObject {
  return {
    groupId,
    objectId,
    status: 0,
    payload: new Uint8Array([Number(objectId)]),
  };
}

test("GroupObjectOrderer: Object ID の昇順で取り出す", () => {
  const orderer = new GroupObjectOrderer();
  // 到着順は 0, 2, 1
  assert.deepEqual(
    orderer.push(makeObject(1n, 0n)).map((obj) => obj.objectId),
    [0n],
  );
  assert.deepEqual(
    orderer.push(makeObject(1n, 2n)).map((obj) => obj.objectId),
    [],
  );
  assert.deepEqual(
    orderer.push(makeObject(1n, 1n)).map((obj) => obj.objectId),
    [1n, 2n],
  );
  assert.strictEqual(orderer.pendingCount, 0);
});

test("GroupObjectOrderer: Group が変わると残りを吐き出してから新しい Group を始める", () => {
  const orderer = new GroupObjectOrderer();
  orderer.push(makeObject(1n, 0n));
  orderer.push(makeObject(1n, 2n));
  // Object 1 が欠けたまま次の Group が来る
  const flushed = orderer.push(makeObject(2n, 0n));
  assert.deepEqual(
    flushed.map((obj) => [obj.groupId, obj.objectId]),
    [
      [1n, 2n],
      [2n, 0n],
    ],
  );
});

test("GroupObjectOrderer: Group の途中から購読した場合は最初の Object ID を起点にする", () => {
  const orderer = new GroupObjectOrderer();
  // Object 3 から届いた場合、0〜2 は待たない
  assert.deepEqual(
    orderer.push(makeObject(7n, 3n)).map((obj) => obj.objectId),
    [3n],
  );
  assert.deepEqual(
    orderer.push(makeObject(7n, 5n)).map((obj) => obj.objectId),
    [],
  );
  assert.deepEqual(
    orderer.push(makeObject(7n, 4n)).map((obj) => obj.objectId),
    [4n, 5n],
  );
});

test("GroupObjectOrderer: reset で保持を捨てる", () => {
  const orderer = new GroupObjectOrderer();
  orderer.push(makeObject(1n, 0n));
  orderer.push(makeObject(1n, 2n));
  assert.strictEqual(orderer.pendingCount, 1);
  orderer.reset();
  assert.strictEqual(orderer.pendingCount, 0);
  // reset 後は最初の Object を新しい起点にする
  assert.deepEqual(
    orderer.push(makeObject(3n, 4n)).map((obj) => obj.objectId),
    [4n],
  );
});
