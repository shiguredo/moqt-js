import { assert, test } from "vite-plus/test";
import { ObjectStatus } from "../../../src/message";
import type { MoqtObject } from "../../../src/dataStream";
import { VideoInitialFill } from "./videoInitialFill";

function received(groupId: bigint, objectId: bigint, fillDelivered = false) {
  const object: MoqtObject = {
    groupId,
    objectId,
    status: ObjectStatus.NORMAL,
    payload: Uint8Array.of(1),
    ...(fillDelivered ? { fillDelivered: true } : {}),
  };
  return { object, receivedAtMs: 0 };
}

test("補完の境界が確定する前に届いたライブを、キャッシュの後から一度だけ復号へ渡す", () => {
  const fill = new VideoInitialFill((object) => object.objectId === 0n);
  const live = received(1n, 2n);
  const key = received(1n, 0n, true);
  const lastCached = received(1n, 1n, true);

  assert.deepEqual(fill.push(live), []);
  assert.deepEqual(fill.push(key), []);
  assert.deepEqual(fill.start({ group: 1n, object: 1n }), [key]);
  assert.deepEqual(fill.push(live), []);
  assert.deepEqual(fill.push(lastCached), [lastCached, live]);
  // リレーの再送が重なっても、同じライブ Object を再投入しない。
  assert.deepEqual(fill.push(live), []);
  assert.deepEqual(fill.push(received(1n, 3n)), [received(1n, 3n)]);
});

test("初回補完の失敗後は次の Group のキーフレームから再開する", () => {
  const fill = new VideoInitialFill((object) => object.objectId === 0n);
  fill.start({ group: 1n, object: 9n });
  assert.deepEqual(fill.push(received(1n, 10n)), []);
  fill.abandon();
  assert.deepEqual(fill.push(received(1n, 0n, true)), []);
  assert.deepEqual(fill.push(received(1n, 11n)), []);
  const delta = received(2n, 1n);
  assert.deepEqual(fill.push(delta), []);
  const key = received(2n, 0n);
  assert.deepEqual(fill.push(key), [key, delta]);
});

test("補完の FIN が先行しても、購読応答の後に保留中のライブを渡す", () => {
  const fill = new VideoInitialFill((object) => object.objectId === 0n);
  const key = received(1n, 0n, true);
  const live = received(1n, 2n);
  fill.push(live);
  fill.push(key);
  fill.finish();
  assert.deepEqual(fill.start({ group: 1n, object: 1n }), [key, live]);
});
