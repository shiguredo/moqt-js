/**
 * Pending Subgroup Buffer Unit Tests
 * draft-ietf-moq-transport-21 §11.3.1
 */

import { test, assert } from "vite-plus/test";
import {
  PendingSubgroupBuffer,
  DEFAULT_PENDING_SUBGROUP_BUFFER_OPTIONS,
} from "./pendingSubgroupBuffer";

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
  const entry = buffer.add(1n);
  assert.equal(buffer.streamCount, 1);
  buffer.remove(entry);
});

test("partial オプションは未指定 field がデフォルトで補完される", () => {
  // perStreamMaxBytes のみ上書きしてその他はデフォルトを期待する
  const buffer = new PendingSubgroupBuffer({ perStreamMaxBytes: 8 });
  const entry = buffer.add(1n);
  buffer.appendChunk(entry, new Uint8Array(10));
  // perStreamMaxBytes=8 を超えたので overflow-per-stream が即発火する
  // (デフォルト perSessionMaxBytes=16 MiB / timeoutMs=5000 は触れていない)
  return entry.notified.then((reason) => {
    assert.equal(reason, "overflow-per-stream");
  });
});

test("add で entry が登録され、streamCount と参照が一致する", () => {
  const buffer = new PendingSubgroupBuffer(makeOptions());
  const entry = buffer.add(7n);
  assert.equal(buffer.streamCount, 1);
  assert.equal(entry.trackAlias, 7n);
  assert.equal(entry.totalBytes, 0);
  assert.equal(entry.chunks.length, 0);
  buffer.remove(entry);
  assert.equal(buffer.streamCount, 0);
});

test("appendChunk で totalBytes と chunks が更新される", () => {
  const buffer = new PendingSubgroupBuffer(makeOptions());
  const entry = buffer.add(1n);
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
  const entry = buffer.add(1n);
  buffer.appendChunk(entry, new Uint8Array(5));
  buffer.appendChunk(entry, new Uint8Array(5));
  const reason = await entry.notified;
  assert.equal(reason, "overflow-per-stream");
});

test("per-session 上限超過で overflow-per-session が通知される", async () => {
  const buffer = new PendingSubgroupBuffer(
    makeOptions({ perStreamMaxBytes: 1024, perSessionMaxBytes: 8, timeoutMs: 10_000 }),
  );
  const entryA = buffer.add(1n);
  const entryB = buffer.add(2n);
  buffer.appendChunk(entryA, new Uint8Array(5));
  buffer.appendChunk(entryB, new Uint8Array(5));
  const reason = await entryB.notified;
  assert.equal(reason, "overflow-per-session");
});

/**
 * draft-ietf-moq-transport-21 §11.3.1:
 * 上限超過で破棄した entry に以後のチャンクを加算しない。加算を続けると
 * 破棄したバイトが per-session の集計に残り、無関係な他ストリームを
 * 巻き添えで overflow させる。
 */
test("per-stream 上限超過で破棄した entry は以後のチャンクを加算しない", async () => {
  const buffer = new PendingSubgroupBuffer(
    makeOptions({ perStreamMaxBytes: 8, perSessionMaxBytes: 1024, timeoutMs: 10_000 }),
  );
  const abandoned = buffer.add(1n);
  buffer.appendChunk(abandoned, new Uint8Array(5));
  buffer.appendChunk(abandoned, new Uint8Array(5));
  assert.equal(await abandoned.notified, "overflow-per-stream");
  const bytesAfterAbandon = buffer.totalBytes;

  // 破棄後のチャンクは保持も加算もしない
  buffer.appendChunk(abandoned, new Uint8Array(100));
  assert.equal(buffer.totalBytes, bytesAfterAbandon);
  assert.equal(abandoned.totalBytes, 10);
  assert.equal(abandoned.chunks.length, 2);
});

/**
 * draft-ietf-moq-transport-21 §11.3.1:
 * 破棄した entry が加算を続けないため、健在な他ストリームが巻き添えで
 * per-session 上限を超えることはない。
 */
test("破棄した entry の後続チャンクが他ストリームを巻き添え overflow させない", async () => {
  const buffer = new PendingSubgroupBuffer(
    makeOptions({ perStreamMaxBytes: 64, perSessionMaxBytes: 100, timeoutMs: 10_000 }),
  );
  const abandoned = buffer.add(1n);
  const healthy = buffer.add(2n);

  // 1 本目が per-stream 上限 (64) を超えて破棄される
  buffer.appendChunk(abandoned, new Uint8Array(40));
  buffer.appendChunk(abandoned, new Uint8Array(40));
  assert.equal(await abandoned.notified, "overflow-per-stream");
  assert.equal(buffer.totalBytes, 80);

  // 破棄された entry へ大量のチャンクが届いても集計は増えない
  for (let i = 0; i < 10; i++) {
    buffer.appendChunk(abandoned, new Uint8Array(100));
  }
  assert.equal(buffer.totalBytes, 80);

  // 健在なストリームは per-session 上限 (100) 内で受け取り続けられる
  buffer.appendChunk(healthy, new Uint8Array(15));
  assert.equal(buffer.totalBytes, 95);
  const healthyResult = await Promise.race([
    healthy.notified.then((reason) => reason),
    new Promise<null>((resolve) => {
      setTimeout(() => {
        resolve(null);
      }, 10);
    }),
  ]);
  assert.isNull(healthyResult);
});

test("remove で集計から減算される", () => {
  const buffer = new PendingSubgroupBuffer(makeOptions());
  const entry = buffer.add(1n);
  buffer.appendChunk(entry, new Uint8Array(10));
  assert.equal(buffer.totalBytes, 10);
  buffer.remove(entry);
  assert.equal(buffer.totalBytes, 0);
  assert.equal(buffer.streamCount, 0);
});

test("notifyAlias で該当 trackAlias の entry のみ通知される", async () => {
  const buffer = new PendingSubgroupBuffer(makeOptions({ timeoutMs: 10_000 }));
  const entryA = buffer.add(1n);
  const entryB = buffer.add(2n);
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
  const entryA = buffer.add(1n);
  const entryB = buffer.add(2n);
  buffer.notifyAll("session-close");
  assert.equal(await entryA.notified, "session-close");
  assert.equal(await entryB.notified, "session-close");
});

test("timeout 経過で timeout が通知される", async () => {
  const buffer = new PendingSubgroupBuffer(makeOptions({ timeoutMs: 30 }));
  const entry = buffer.add(1n);
  const reason = await entry.notified;
  assert.equal(reason, "timeout");
});

test("notify は 1 回しか resolve しない", async () => {
  const buffer = new PendingSubgroupBuffer(makeOptions({ timeoutMs: 10_000 }));
  const entry = buffer.add(1n);
  assert.isTrue(entry.notify("subscriber"));
  assert.isFalse(entry.notify("timeout"));
  assert.isFalse(entry.notify("session-close"));
  const reason = await entry.notified;
  assert.equal(reason, "subscriber");
});

test("notify 後の remove で timeout が解除されている", () => {
  const buffer = new PendingSubgroupBuffer(makeOptions({ timeoutMs: 10_000 }));
  const entry = buffer.add(1n);
  entry.notify("subscriber");
  assert.isNull(entry.timeoutHandle);
  buffer.remove(entry);
  assert.equal(buffer.streamCount, 0);
});

test("同じ trackAlias で複数 entry を保持できる", async () => {
  const buffer = new PendingSubgroupBuffer(makeOptions({ timeoutMs: 10_000 }));
  const entryA = buffer.add(5n);
  const entryB = buffer.add(5n);
  assert.equal(buffer.streamCount, 2);
  buffer.notifyAlias(5n, "subscriber");
  assert.equal(await entryA.notified, "subscriber");
  assert.equal(await entryB.notified, "subscriber");
});

test("remove 済みの entry に対する remove は no-op", () => {
  const buffer = new PendingSubgroupBuffer(makeOptions());
  const entry = buffer.add(1n);
  buffer.appendChunk(entry, new Uint8Array(10));
  buffer.remove(entry);
  buffer.remove(entry);
  assert.equal(buffer.streamCount, 0);
  assert.equal(buffer.totalBytes, 0);
});
