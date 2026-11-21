/**
 * Pending Subgroup Buffer Unit Tests
 * draft-ietf-moq-transport-23 §11.3.1
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

// 既定値そのもの (1 MiB / 16 MiB / 5000 ms) と、partial 指定時に未指定 field が
// 既定値で補完されることを 1 件にまとめて確認する。
test("オプション省略時と partial 指定時はデフォルトが補完される", async () => {
  assert.equal(DEFAULT_PENDING_SUBGROUP_BUFFER_OPTIONS.perStreamMaxBytes, 1 << 20);
  assert.equal(DEFAULT_PENDING_SUBGROUP_BUFFER_OPTIONS.perSessionMaxBytes, 16 << 20);
  assert.equal(DEFAULT_PENDING_SUBGROUP_BUFFER_OPTIONS.timeoutMs, 5000);

  // コンストラクタ引数を省略してもエラーにならず、buffer が動作する
  const buffer = new PendingSubgroupBuffer();
  const entry = buffer.add(1n);
  assert.equal(buffer.streamCount, 1);
  buffer.remove(entry);

  // perStreamMaxBytes のみ上書きしてその他はデフォルトを期待する
  const partial = new PendingSubgroupBuffer({ perStreamMaxBytes: 8 });
  const partialEntry = partial.add(1n);
  partial.appendChunk(partialEntry, new Uint8Array(10));
  // perStreamMaxBytes=8 を超えたので overflow-per-stream が即発火する
  // (デフォルト perSessionMaxBytes=16 MiB / timeoutMs=5000 は触れていない)
  const reason = await partialEntry.notified;
  assert.equal(reason, "overflow-per-stream");
});

test("add で entry が登録され、streamCount と参照が一致する", () => {
  const buffer = new PendingSubgroupBuffer(makeOptions());
  const entry = buffer.add(7n);
  assert.equal(buffer.streamCount, 1);
  assert.equal(entry.trackAlias, 7n);
  assert.equal(entry.totalBytes, 0);
  buffer.remove(entry);
  assert.equal(buffer.streamCount, 0);
});

test("バイトを保持していない Subgroup も保留ストリーム数の上限に含める", () => {
  const buffer = new PendingSubgroupBuffer(makeOptions({ timeoutMs: 10_000 }));
  const entries = Array.from({ length: 1024 }, (_, i) => buffer.add(BigInt(i % 2)));
  try {
    const rejected = buffer.add(2n);
    assert.equal(rejected.reason, "overflow-stream-count");
    assert.isNull(rejected.timeoutHandle);
    assert.equal(buffer.streamCount, 1024);
    assert.equal(buffer.totalBytes, 0);

    // 重複解除で空き枠が水増しされない。実際に空いた 1 枠だけが再利用できる。
    buffer.remove(entries[0]!);
    buffer.remove(entries[0]!);
    assert.equal(buffer.streamCount, 1023);
    assert.isNull(buffer.add(2n).reason);
    assert.equal(buffer.streamCount, 1024);
    assert.equal(buffer.add(3n).reason, "overflow-stream-count");
  } finally {
    buffer.close();
  }
  assert.equal(buffer.streamCount, 0);
});

test("保留バッファを引き継ぐとチャンクの順序を保ち、保留側の計上を解放する", () => {
  const buffer = new PendingSubgroupBuffer(makeOptions());
  const entry = buffer.add(1n);
  buffer.appendChunk(entry, new Uint8Array([1, 2, 3]));
  buffer.appendChunk(entry, new Uint8Array([4, 5]));
  assert.equal(entry.totalBytes, 5);
  assert.equal(buffer.totalBytes, 5);
  buffer.remove(entry);
  assert.deepEqual(entry.takeBuffer().view(), new Uint8Array([1, 2, 3, 4, 5]));
  assert.equal(buffer.totalBytes, 0);
  assert.equal(entry.totalBytes, 0);
});

test("大きな元配列のごく一部だけを保留するときは小さい配列へ移す", () => {
  const buffer = new PendingSubgroupBuffer(makeOptions());
  const entry = buffer.add(1n);
  const chunk = new Uint8Array(4096);
  chunk.set([1, 2, 3], 127);
  buffer.appendChunk(entry, chunk.subarray(127, 130));
  buffer.remove(entry);

  const retained = entry.takeBuffer().view();
  assert.deepEqual(retained, new Uint8Array([1, 2, 3]));
  assert.equal(retained.buffer.byteLength, 3);
});

test("細かいチャンクを連続バッファへ切り替えても、引き継いだバイト列に欠落はない", () => {
  const buffer = new PendingSubgroupBuffer(makeOptions());
  const entry = buffer.add(1n);
  // 連続化の境界と、その後の容量拡張をまたぐ。
  const expected = Uint8Array.from({ length: 256 }, (_, index) => index);
  for (const value of expected) {
    buffer.appendChunk(entry, Uint8Array.of(value));
  }
  assert.equal(buffer.totalBytes, expected.byteLength);
  buffer.remove(entry);

  const retained = entry.takeBuffer().view();
  assert.deepEqual(retained, expected);
  assert.isAtMost(retained.buffer.byteLength, 2 * expected.byteLength);
  assert.isEmpty(entry.takeBuffer().view());
  assert.equal(buffer.totalBytes, 0);
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
 * draft-ietf-moq-transport-23 §11.3.1:
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
  assert.equal(buffer.totalBytes, 0);

  // 破棄後のチャンクは保持も加算もしない
  buffer.appendChunk(abandoned, new Uint8Array(100));
  assert.equal(buffer.totalBytes, 0);
  assert.equal(abandoned.totalBytes, 0);
  assert.isEmpty(abandoned.takeBuffer().view());
});

/**
 * draft-ietf-moq-transport-23 §11.3.1:
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
  assert.equal(buffer.totalBytes, 0);

  // 破棄された entry へ大量のチャンクが届いても集計は増えない
  for (let i = 0; i < 10; i++) {
    buffer.appendChunk(abandoned, new Uint8Array(100));
  }
  assert.equal(buffer.totalBytes, 0);

  // 健在なストリームは per-session 上限 (100) 内で受け取り続けられる
  buffer.appendChunk(healthy, new Uint8Array(15));
  assert.equal(buffer.totalBytes, 15);
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

test("削除済みの entry に届いたチャンクは集計に残らない", () => {
  const buffer = new PendingSubgroupBuffer(makeOptions());
  const entry = buffer.add(7n);
  buffer.appendChunk(entry, new Uint8Array(5));
  buffer.remove(entry);

  // 遅れて処理された read の結果が、もう解放したストリームのバイトを戻さない。
  buffer.appendChunk(entry, new Uint8Array(10));
  assert.equal(buffer.totalBytes, 0);
  assert.equal(entry.totalBytes, 5);
});

test("別の buffer が所有する entry を remove してもタイマーを解除しない", () => {
  const owner = new PendingSubgroupBuffer(makeOptions({ timeoutMs: 10_000 }));
  const other = new PendingSubgroupBuffer(makeOptions());
  const entry = owner.add(7n);
  // この entry の終了とバイト集計は、登録した側だけが管理する。
  other.remove(entry);
  try {
    assert.isNotNull(entry.timeoutHandle);
    assert.equal(owner.streamCount, 1);
    assert.equal(other.streamCount, 0);
  } finally {
    owner.remove(entry);
  }
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

test("session close で全 entry の待機と保持バイトを解放する", async () => {
  const buffer = new PendingSubgroupBuffer(makeOptions({ timeoutMs: 10_000 }));
  const entryA = buffer.add(1n);
  const entryB = buffer.add(2n);
  buffer.appendChunk(entryA, new Uint8Array(2));
  buffer.appendChunk(entryB, new Uint8Array(3));
  buffer.close();
  assert.equal(await entryA.notified, "session-close");
  assert.equal(await entryB.notified, "session-close");
  assert.equal(buffer.totalBytes, 0);
  assert.equal(buffer.streamCount, 0);
});

test("解除済み Alias の記録は直近 1024 件を保持し、再登録で外す", () => {
  const buffer = new PendingSubgroupBuffer();
  for (let alias = 0n; alias <= 1024n; alias++) {
    buffer.retireAlias(alias);
  }
  assert.isFalse(buffer.isRetiredAlias(0n));
  assert.isTrue(buffer.isRetiredAlias(1n));
  assert.isTrue(buffer.isRetiredAlias(1024n));
  buffer.reopenAlias(1024n);
  assert.isFalse(buffer.isRetiredAlias(1024n));
  buffer.close();
  assert.isFalse(buffer.isRetiredAlias(1n));
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
