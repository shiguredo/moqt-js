import { assert, test } from "vite-plus/test";
import { ObjectStatus } from "../message";
import type { MoqtObject } from "../dataStream";
import {
  VIDEO_INITIAL_FILL_OPTIONS,
  VIDEO_INITIAL_FILL_TIMEOUT_MS,
  VideoInitialFill,
} from "./videoInitialFill";

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

test("初回 fill は relay が上流の cache まで取りに行ける予算を要求する", () => {
  // draft-ietf-moq-transport-23 §9.19.5: FILL_TIMEOUT = 0 は「すぐ取得できる Object だけを
  // 要求する」意味であり、relay は不足分を上流から取らずに MUST で Timed-Out gap にする。
  // 購読ノードの cache が冷えていると、それだけで現在の Group の先頭が欠けて次の
  // キーフレームまで復号できない。クライアントが fill を待つ 5 秒と同じ予算を要求する。
  assert.equal(VIDEO_INITIAL_FILL_OPTIONS.fill.fillTimeout, BigInt(VIDEO_INITIAL_FILL_TIMEOUT_MS));
  assert.isTrue(VIDEO_INITIAL_FILL_OPTIONS.fill.fillTimeout > 0n);
});

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
