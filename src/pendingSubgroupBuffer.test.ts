/**
 * Pending Subgroup Buffer Unit Tests
 * draft-ietf-moq-transport-19 §11.4.2
 */

import { test, assert } from "vite-plus/test";
import {
  PendingSubgroupBuffer,
  DEFAULT_PENDING_SUBGROUP_BUFFER_OPTIONS,
} from "./pendingSubgroupBuffer";
import type { SubgroupHeader } from "./dataStream";

function makeHeader(trackAlias: bigint, groupId = 0n): SubgroupHeader {
  return {
    type: 0x10,
    trackAlias,
    groupId,
    publisherPriority: 128,
  };
}

function makeOptions(
  overrides: Partial<{
    perStreamMaxBytes: number;
    perSessionMaxBytes: number;
    timeoutMs: number;
  }> = {},
) {
  return {
    perStreamMaxBytes: 1024,
    perSessionMaxBytes: 4096,
    timeoutMs: 100,
    ...overrides,
  };
}

test("空の buffer は streamCount=0, totalBytes=0", () => {
  const buffer = new PendingSubgroupBuffer(makeOptions());
  assert.equal(buffer.streamCount, 0);
  assert.equal(buffer.totalBytes, 0);
});

test("オプション省略時はデフォルトが適用される (1 MiB / 16 MiB / 5000 ms)", () => {
  assert.equal(DEFAULT_PENDING_SUBGROUP_BUFFER_OPTIONS.perStreamMaxBytes, 1 << 20);
  assert.equal(DEFAULT_PENDING_SUBGROUP_BUFFER_OPTIONS.perSessionMaxBytes, 16 << 20);
  assert.equal(DEFAULT_PENDING_SUBGROUP_BUFFER_OPTIONS.timeoutMs, 5000);
  // コンストラクタ引数を省略してもエラーにならず、buffer が動作する
  const buffer = new PendingSubgroupBuffer();
  const entry = buffer.add(1n, makeHeader(1n));
  assert.equal(buffer.streamCount, 1);
  buffer.remove(entry);
});

test("partial オプションは未指定 field がデフォルトで補完される", () => {
  // perStreamMaxBytes のみ上書きしてその他はデフォルトを期待する
  const buffer = new PendingSubgroupBuffer({ perStreamMaxBytes: 8 });
  const entry = buffer.add(1n, makeHeader(1n));
  buffer.appendChunk(entry, new Uint8Array(10));
  // perStreamMaxBytes=8 を超えたので overflow-per-stream が即発火する
  // (デフォルト perSessionMaxBytes=16 MiB / timeoutMs=5000 は触れていない)
  return entry.notified.then((reason) => {
    assert.equal(reason, "overflow-per-stream");
  });
});

test("add で entry が登録され、streamCount と参照が一致する", () => {
  const buffer = new PendingSubgroupBuffer(makeOptions());
  const entry = buffer.add(7n, makeHeader(7n));
  assert.equal(buffer.streamCount, 1);
  assert.equal(entry.trackAlias, 7n);
  assert.equal(entry.totalBytes, 0);
  assert.equal(entry.chunks.length, 0);
  buffer.remove(entry);
  assert.equal(buffer.streamCount, 0);
});

test("appendChunk で totalBytes と chunks が更新される", () => {
  const buffer = new PendingSubgroupBuffer(makeOptions());
  const entry = buffer.add(1n, makeHeader(1n));
  buffer.appendChunk(entry, new Uint8Array([1, 2, 3]));
  buffer.appendChunk(entry, new Uint8Array([4, 5]));
  assert.equal(entry.totalBytes, 5);
  assert.equal(entry.chunks.length, 2);
  assert.equal(buffer.totalBytes, 5);
});

test("per-stream 上限超過で overflow-per-stream が通知される", async () => {
  const buffer = new PendingSubgroupBuffer(
    makeOptions({ perStreamMaxBytes: 8, perSessionMaxBytes: 1024, timeoutMs: 10_000 }),
  );
  const entry = buffer.add(1n, makeHeader(1n));
  buffer.appendChunk(entry, new Uint8Array(5));
  buffer.appendChunk(entry, new Uint8Array(5));
  const reason = await entry.notified;
  assert.equal(reason, "overflow-per-stream");
});

test("per-session 上限超過で overflow-per-session が通知される", async () => {
  const buffer = new PendingSubgroupBuffer(
    makeOptions({ perStreamMaxBytes: 1024, perSessionMaxBytes: 8, timeoutMs: 10_000 }),
  );
  const entryA = buffer.add(1n, makeHeader(1n));
  const entryB = buffer.add(2n, makeHeader(2n));
  buffer.appendChunk(entryA, new Uint8Array(5));
  buffer.appendChunk(entryB, new Uint8Array(5));
  const reason = await entryB.notified;
  assert.equal(reason, "overflow-per-session");
});

test("remove で集計から減算される", () => {
  const buffer = new PendingSubgroupBuffer(makeOptions());
  const entry = buffer.add(1n, makeHeader(1n));
  buffer.appendChunk(entry, new Uint8Array(10));
  assert.equal(buffer.totalBytes, 10);
  buffer.remove(entry);
  assert.equal(buffer.totalBytes, 0);
  assert.equal(buffer.streamCount, 0);
});

test("notifyAlias で該当 trackAlias の entry のみ通知される", async () => {
  const buffer = new PendingSubgroupBuffer(makeOptions({ timeoutMs: 10_000 }));
  const entryA = buffer.add(1n, makeHeader(1n));
  const entryB = buffer.add(2n, makeHeader(2n));
  buffer.notifyAlias(1n, "subscriber");
  const reasonA = await entryA.notified;
  assert.equal(reasonA, "subscriber");
  // entryB は未通知 (Promise.race でタイムアウトを使って確認)
  const winner = await Promise.race([
    entryB.notified.then((r) => ({ done: true as const, reason: r })),
    new Promise<{ done: false }>((resolve) => {
      setTimeout(() => resolve({ done: false }), 30);
    }),
  ]);
  assert.isFalse(winner.done);
});

test("notifyAll で全 entry が通知される (session close)", async () => {
  const buffer = new PendingSubgroupBuffer(makeOptions({ timeoutMs: 10_000 }));
  const entryA = buffer.add(1n, makeHeader(1n));
  const entryB = buffer.add(2n, makeHeader(2n));
  buffer.notifyAll("session-close");
  assert.equal(await entryA.notified, "session-close");
  assert.equal(await entryB.notified, "session-close");
});

test("timeout 経過で timeout が通知される", async () => {
  const buffer = new PendingSubgroupBuffer(makeOptions({ timeoutMs: 30 }));
  const entry = buffer.add(1n, makeHeader(1n));
  const reason = await entry.notified;
  assert.equal(reason, "timeout");
});

test("notify は 1 回しか resolve しない", async () => {
  const buffer = new PendingSubgroupBuffer(makeOptions({ timeoutMs: 10_000 }));
  const entry = buffer.add(1n, makeHeader(1n));
  assert.isTrue(entry.notify("subscriber"));
  assert.isFalse(entry.notify("timeout"));
  assert.isFalse(entry.notify("session-close"));
  const reason = await entry.notified;
  assert.equal(reason, "subscriber");
});

test("notify 後の remove で timeout が解除されている", () => {
  const buffer = new PendingSubgroupBuffer(makeOptions({ timeoutMs: 10_000 }));
  const entry = buffer.add(1n, makeHeader(1n));
  entry.notify("subscriber");
  assert.isNull(entry.timeoutHandle);
  buffer.remove(entry);
  assert.equal(buffer.streamCount, 0);
});

test("同じ trackAlias で複数 entry を保持できる", async () => {
  const buffer = new PendingSubgroupBuffer(makeOptions({ timeoutMs: 10_000 }));
  const entryA = buffer.add(5n, makeHeader(5n, 0n));
  const entryB = buffer.add(5n, makeHeader(5n, 1n));
  assert.equal(buffer.streamCount, 2);
  buffer.notifyAlias(5n, "subscriber");
  assert.equal(await entryA.notified, "subscriber");
  assert.equal(await entryB.notified, "subscriber");
});

test("remove 済みの entry に対する remove は no-op", () => {
  const buffer = new PendingSubgroupBuffer(makeOptions());
  const entry = buffer.add(1n, makeHeader(1n));
  buffer.appendChunk(entry, new Uint8Array(10));
  buffer.remove(entry);
  buffer.remove(entry);
  assert.equal(buffer.streamCount, 0);
  assert.equal(buffer.totalBytes, 0);
});
