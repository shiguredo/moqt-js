/**
 * PreDecodeDelayQueue の Property-Based Tests
 *
 * 積む操作と取り出す操作を任意の時刻の列として生成し、復号前の遅延キューが満たすべき
 * 性質を確かめる。
 *
 * - 取り出した Object は積んだ順の部分列であり、同じ Object を 2 回取り出さない
 * - 積んだバイト数 = 落としたバイト数 + 取り出したバイト数 + 保持しているバイト数
 * - 保持しているバイト数は上限を超えない (1 件で上限を超える Object は保持しない)
 * - 上限が無いときは、期限 (積んだ時刻 + 遅延) の前の Object を取り出さない
 *
 * 個別の規則 (境界値、単一の巨大 Object、上限 0 以下の無制限、setDelayMs の期限の計算、
 * 上限超過が続く間の取り出し、空になった後の短縮の解除) は
 * src/playout/preDecodeDelay.test.ts の単体テストが固定する。
 */

import { test, assert } from "vite-plus/test";
import * as fc from "fast-check";
import { PreDecodeDelayQueue } from "./preDecodeDelay";

/** キューへ積む 1 件分 */
interface TestItem {
  readonly id: number;
  readonly bytes: number;
  readonly enqueuedAtMs: number;
}

/** 時刻を進めて積む操作 */
interface PushOperation {
  readonly kind: "push";
  readonly bytes: number;
  readonly advanceMs: number;
}

/** 時刻を進めて期限分を取り出す操作 */
interface TakeOperation {
  readonly kind: "take";
  readonly advanceMs: number;
}

/** 上限超過の同期を模して短縮量を外から設定する操作 */
interface ShortenOperation {
  readonly kind: "shorten";
  readonly shortenMs: number;
  readonly advanceMs: number;
}

/** 任意の操作列 */
type Operation = PushOperation | TakeOperation | ShortenOperation;

/** 積む操作と取り出す操作の任意列 */
const operationsArbitrary: fc.Arbitrary<Operation[]> = fc.array(
  fc.oneof(
    fc.record<PushOperation>({
      kind: fc.constant("push"),
      bytes: fc.integer({ min: 1, max: 40 }),
      advanceMs: fc.integer({ min: 0, max: 20 }),
    }),
    fc.record<TakeOperation>({
      kind: fc.constant("take"),
      advanceMs: fc.integer({ min: 0, max: 300 }),
    }),
    fc.record<ShortenOperation>({
      kind: fc.constant("shorten"),
      shortenMs: fc.integer({ min: 0, max: 1_000 }),
      advanceMs: fc.integer({ min: 0, max: 20 }),
    }),
  ),
  { minLength: 1, maxLength: 80 },
);

// 積んだ順に取り出し、バイト数の保存と上限を守る。
test("PreDecodeDelayQueue: 積んだ順に取り出し、バイト数が保存される", () => {
  fc.assert(
    fc.property(
      operationsArbitrary,
      fc.integer({ min: 0, max: 500 }),
      fc.integer({ min: 1, max: 120 }),
      (operations, delayMs, maxBytes) => {
        const queue = new PreDecodeDelayQueue<TestItem>({ delayMs, maxBytes, maxObjects: 0 });
        let nowMs = 0;
        let nextId = 0;
        let pushedBytes = 0;
        let droppedBytes = 0;
        let droppedCount = 0;
        const records: TestItem[] = [];
        const taken: number[] = [];

        for (const operation of operations) {
          nowMs += operation.advanceMs;
          if (operation.kind === "push") {
            const item: TestItem = { id: nextId, bytes: operation.bytes, enqueuedAtMs: nowMs };
            nextId += 1;
            pushedBytes += operation.bytes;
            records.push(item);
            const result = queue.push(item, operation.bytes, nowMs);
            droppedCount += result.dropped.length;
            for (const dropped of result.dropped) {
              droppedBytes += dropped.bytes;
            }
          } else if (operation.kind === "take") {
            for (const item of queue.takeDue(nowMs)) {
              taken.push(item.id);
            }
          } else {
            queue.setDelayShortenMs(Math.min(delayMs, operation.shortenMs));
          }
          assert.isAtMost(queue.bufferedBytes, maxBytes, "保持バイト数が上限を超えないこと");
        }

        // 取り出した Object は積んだ順の部分列であり、重複しない
        for (let index = 1; index < taken.length; index++) {
          assert.isBelow(
            taken[index - 1] ?? -1,
            taken[index] ?? -1,
            "取り出した Object が積んだ順であること",
          );
        }

        // 積んだバイト数 = 落とした + 取り出した + 保持している
        let takenBytes = 0;
        for (const id of taken) {
          takenBytes += records[id]?.bytes ?? 0;
        }
        // 保持しているバイト数はキューが数えている値を使う (落とした分と取り出した分の合計で検算する)
        assert.equal(queue.bufferedBytes, pushedBytes - droppedBytes - takenBytes);
        assert.equal(queue.size, nextId - droppedCount - taken.length);
      },
    ),
    { numRuns: 200 },
  );
});

// 上限が無いときは、期限の前の Object を取り出さない (上限超過による短縮も無い)。
test("PreDecodeDelayQueue: 上限が無ければ期限の前の Object を取り出さない", () => {
  fc.assert(
    fc.property(operationsArbitrary, fc.integer({ min: 0, max: 1_000 }), (operations, delayMs) => {
      const queue = new PreDecodeDelayQueue<TestItem>({
        delayMs,
        maxBytes: 0,
        maxObjects: 0,
      });
      let nowMs = 0;
      let nextId = 0;
      for (const operation of operations) {
        nowMs += operation.advanceMs;
        if (operation.kind === "push") {
          queue.push(
            { id: nextId, bytes: operation.bytes, enqueuedAtMs: nowMs },
            operation.bytes,
            nowMs,
          );
          nextId += 1;
          continue;
        }
        for (const item of queue.takeDue(nowMs)) {
          assert.isAtMost(
            item.enqueuedAtMs + delayMs,
            nowMs,
            "期限の前の Object を取り出さないこと",
          );
        }
      }
    }),
    { numRuns: 200 },
  );
});

// 積む時刻が前後しても、取り出す順序は期限の昇順になる。
test("PreDecodeDelayQueue: 任意の時刻の列でも取り出し順が期限の昇順になる", () => {
  fc.assert(
    fc.property(
      fc.array(fc.integer({ min: 0, max: 2_000 }), { minLength: 1, maxLength: 40 }),
      fc.integer({ min: 0, max: 500 }),
      (times, delayMs) => {
        const queue = new PreDecodeDelayQueue<number>({
          delayMs,
          maxBytes: 0,
          maxObjects: 0,
        });
        times.forEach((enqueuedAtMs, index) => {
          queue.push(index, 1, enqueuedAtMs);
        });
        const expected = [...times]
          .map((enqueuedAtMs, index) => ({ enqueuedAtMs, index }))
          .sort((left, right) => left.enqueuedAtMs - right.enqueuedAtMs)
          .map((entry) => entry.index);
        const taken = queue.takeDue(Number.MAX_SAFE_INTEGER);
        assert.deepEqual(taken, expected, "期限の昇順に取り出すこと");
      },
    ),
    { numRuns: 200 },
  );
});
