/**
 * AudioReceiveOrderTracker (音声 Object の受信順の観測) の単体テスト
 *
 * 境界未確定、cache replay の除外、境界確定前の copy、冗長化 copy の 1 回計上、
 * 同一 Group 内の順序逆転、Group 距離、window からの追い出しを固定する。
 */

import { test, assert } from "vite-plus/test";
import { AudioReceiveOrderTracker } from "./audioReceiveOrder";

/** 比較用の Location を作る */
function location(group: bigint, object: bigint): { group: bigint; object: bigint } {
  return { group, object };
}

test("AudioReceiveOrderTracker: 境界が確定するまでは順序逆転を数えない", () => {
  const tracker = new AudioReceiveOrderTracker();
  // 境界が決まる前の受信は最大 Location の更新だけを行う
  assert.deepEqual(tracker.observe(location(10n, 0n)), {
    outOfOrder: false,
    duplicate: false,
    groupDistance: 0,
  });
  assert.deepEqual(tracker.observe(location(9n, 0n)), {
    outOfOrder: false,
    duplicate: false,
    groupDistance: 0,
  });

  tracker.markBoundary(location(10n, 0n));

  // 境界以下の Location は cache 由来として数えない (境界前に見た Location は duplicate)
  assert.deepEqual(tracker.observe(location(9n, 0n)), {
    outOfOrder: false,
    duplicate: true,
    groupDistance: 0,
  });
});

test("AudioReceiveOrderTracker: LARGEST_OBJECT 以下の cache は順序逆転として数えない", () => {
  const tracker = new AudioReceiveOrderTracker();
  tracker.markBoundary(location(10n, 5n));
  tracker.observe(location(11n, 0n));

  assert.equal(tracker.observe(location(10n, 5n)).outOfOrder, false, "境界と同じ Location");
  assert.equal(tracker.observe(location(8n, 0n)).outOfOrder, false, "境界より前の Location");
});

test("AudioReceiveOrderTracker: 冗長化の copy を 2 回目以降は duplicate とし、順序逆転に数えない", () => {
  const tracker = new AudioReceiveOrderTracker();
  tracker.markBoundary(location(10n, 0n));
  tracker.observe(location(12n, 0n));

  const first = tracker.observe(location(11n, 0n));
  assert.deepEqual(first, { outOfOrder: true, duplicate: false, groupDistance: 1 });

  // 同じ Location の 2 個目は重複である
  assert.deepEqual(tracker.observe(location(11n, 0n)), {
    outOfOrder: false,
    duplicate: true,
    groupDistance: 0,
  });
});

test("AudioReceiveOrderTracker: 同一 Group 内の逆行は距離 0 として数える", () => {
  const tracker = new AudioReceiveOrderTracker();
  tracker.markBoundary(location(10n, 0n));
  tracker.observe(location(12n, 2n));

  const result = tracker.observe(location(12n, 1n));
  assert.isTrue(result.outOfOrder);
  assert.equal(result.groupDistance, 0, "同じ Group 内の逆行は Group 距離 0");
});

test("AudioReceiveOrderTracker: 境界確定前の copy は境界確定後に順序逆転として数えない", () => {
  const tracker = new AudioReceiveOrderTracker();
  // 境界の確定前に live の Object が届き、その copy が後から届く場合
  tracker.observe(location(11n, 0n));
  tracker.observe(location(12n, 0n));
  tracker.markBoundary(location(10n, 0n));

  const result = tracker.observe(location(11n, 0n));
  assert.isFalse(result.outOfOrder, "境界確定前に見た Location の copy は順序逆転ではない");
  assert.isTrue(result.duplicate);
});

test("AudioReceiveOrderTracker: window から追い出された Location は新しい観測として扱う", () => {
  const tracker = new AudioReceiveOrderTracker(2);
  tracker.markBoundary(location(0n, 0n));
  tracker.observe(location(1n, 0n));
  tracker.observe(location(2n, 0n));
  // ここで window は {2, 3} になり、1 は追い出される
  tracker.observe(location(3n, 0n));

  const result = tracker.observe(location(1n, 0n));
  assert.isTrue(result.outOfOrder);
  assert.isFalse(result.duplicate, "window から追い出された Location は重複としない");
});

test("AudioReceiveOrderTracker: 最大 Location のキーが window から消えても等値は順序逆転としない", () => {
  const tracker = new AudioReceiveOrderTracker(1);
  tracker.markBoundary(null);
  tracker.observe(location(12n, 0n));
  // 11 を観測した時点で window から 12 のキーが追い出される。largest は 12 のまま
  tracker.observe(location(11n, 0n));

  const result = tracker.observe(location(12n, 0n));
  assert.isFalse(result.outOfOrder, "最大 Location と同じ Location は順序逆転ではない");
});

test("AudioReceiveOrderTracker: Group 距離は Number.MAX_SAFE_INTEGER で頭打ちにする", () => {
  const tracker = new AudioReceiveOrderTracker();
  // cache 境界を無しにして、境界フィルタで捨てられないようにする
  tracker.markBoundary(null);
  const large = BigInt(Number.MAX_SAFE_INTEGER) + 2n;
  tracker.observe(location(large, 0n));

  const result = tracker.observe(location(0n, 0n));
  assert.isTrue(result.outOfOrder);
  assert.equal(result.groupDistance, Number.MAX_SAFE_INTEGER);
});
