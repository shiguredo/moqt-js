/**
 * PreDecodeDelayQueue (復号前の Object を時間で保持するキュー) の単体テスト
 *
 * タイマーは持たないため、すべて時刻を引数で渡して固定する。2 秒の遅延は実際に待たず、
 * 期限の計算だけで検証する。
 */

import { test, assert } from "vite-plus/test";
import {
  MAX_PRE_DECODE_DELAY_MS,
  PreDecodeDelayQueue,
  type PreDecodeDelayQueueOptions,
} from "./preDecodeDelay";

/** テストで使う遅延 (ミリ秒) */
const DELAY_MS = 2_000;

/** テスト用のキューを作る */
function makeQueue(options: Partial<PreDecodeDelayQueueOptions> = {}): PreDecodeDelayQueue<string> {
  return new PreDecodeDelayQueue<string>({ delayMs: DELAY_MS, ...options });
}

// 2 秒の遅延では、期限の 1 ms 前まで取り出せず、期限ちょうどで取り出せる。
test("PreDecodeDelayQueue: 2 秒の期限まで Object を取り出さない", () => {
  const queue = makeQueue();
  const result = queue.push("a", 3, 1_000);

  assert.equal(result.dropped.length, 0, "上限内の追加では落とさないこと");
  assert.isFalse(result.overflowed, "上限内の追加では overflow にしないこと");
  assert.equal(queue.size, 1);
  assert.equal(queue.bufferedBytes, 3);
  assert.equal(queue.nextDueMs(), 3_000);

  assert.deepEqual(queue.takeDue(2_999), [], "期限の 1 ms 前では取り出さないこと");
  assert.equal(queue.size, 1, "期限前は保持したままであること");
  assert.deepEqual(queue.takeDue(3_000), ["a"], "期限ちょうどで取り出すこと");
  assert.equal(queue.size, 0);
  assert.equal(queue.bufferedBytes, 0, "取り出した分のバイト数を戻すこと");
  assert.isNull(queue.nextDueMs(), "空になったら次の期限は無いこと");
});

// 積んだ時刻が前後しても、期限の昇順に並べて取り出す。
test("PreDecodeDelayQueue: 期限の昇順に並べて取り出す", () => {
  const queue = makeQueue();
  queue.push("先に積んだが期限が遅い", 1, 1_000);
  queue.push("後に積んだが期限が早い", 1, 500);

  assert.equal(queue.nextDueMs(), 2_500, "期限が最も早い Object を先頭にすること");
  assert.deepEqual(
    queue.takeDue(2_600),
    ["後に積んだが期限が早い"],
    "期限が来た Object だけを取り出すこと",
  );
  assert.deepEqual(
    queue.takeDue(3_000),
    ["先に積んだが期限が遅い"],
    "残りの Object を期限で取り出すこと",
  );
});

// 同じ期限の Object は積んだ順に取り出す (安定した順序)。
test("PreDecodeDelayQueue: 同じ期限の Object は積んだ順に取り出す", () => {
  const queue = makeQueue();
  queue.push("1 件目", 1, 1_000);
  queue.push("2 件目", 1, 1_000);
  queue.push("3 件目", 1, 1_000);

  assert.deepEqual(queue.takeDue(3_000), ["1 件目", "2 件目", "3 件目"]);
});

// clear は保持している Object とバイト数をすべて捨てる。
test("PreDecodeDelayQueue: clear で保持とバイト数を捨てる", () => {
  const queue = makeQueue();
  queue.push("a", 4, 1_000);
  queue.push("b", 6, 1_000);
  assert.equal(queue.bufferedBytes, 10);

  queue.clear();

  assert.equal(queue.size, 0);
  assert.equal(queue.bufferedBytes, 0);
  assert.isNull(queue.nextDueMs());
  assert.deepEqual(queue.takeDue(10_000), []);
});

// 件数上限を超えたら古い Object から落とす。
test("PreDecodeDelayQueue: 件数上限を超えたら古い Object から落とす", () => {
  const queue = makeQueue({ maxObjects: 2 });
  queue.push("a", 1, 1_000);
  queue.push("b", 1, 1_000);
  const result = queue.push("c", 1, 1_000);

  assert.isTrue(result.overflowed);
  assert.deepEqual(result.dropped, ["a"], "古い Object を落とすこと");
  assert.equal(queue.size, 2);
  assert.deepEqual(queue.takeDue(3_000), ["b", "c"]);
});

// バイト上限を超えたら古い Object から落とし、保持しているバイト数を合わせる。
test("PreDecodeDelayQueue: バイト上限を超えたら古い Object から落とす", () => {
  const queue = makeQueue({ maxBytes: 10 });
  queue.push("a", 6, 1_000);
  const result = queue.push("b", 6, 1_000);

  assert.isTrue(result.overflowed);
  assert.deepEqual(result.dropped, ["a"]);
  assert.equal(queue.size, 1);
  assert.equal(queue.bufferedBytes, 6, "落とした分のバイト数を引くこと");
  assert.deepEqual(queue.takeDue(3_000), ["b"]);
});

// 1 件だけでバイト上限を超える Object は保持しない。
test("PreDecodeDelayQueue: 1 件でバイト上限を超える Object は保持しない", () => {
  const queue = makeQueue({ maxBytes: 10 });
  const result = queue.push("巨大", 11, 1_000);

  assert.isTrue(result.overflowed);
  assert.deepEqual(result.dropped, ["巨大"]);
  assert.equal(queue.size, 0);
  assert.equal(queue.bufferedBytes, 0);
  assert.isNull(queue.nextDueMs());
});

// 上限に 0 以下を指定したら無制限にする (既存の受信バッファ上限の規約に合わせる)。
test("PreDecodeDelayQueue: 上限に 0 以下を指定したら無制限にする", () => {
  const queue = makeQueue({ maxBytes: 0, maxObjects: 0 });
  for (let index = 0; index < 20; index++) {
    const result = queue.push(`object-${index}`, 1_000_000, 1_000);
    assert.isFalse(result.overflowed, "上限が無制限なら overflow にしないこと");
  }
  assert.equal(queue.size, 20);
});

// 遅延 0 では積んだ直後に取り出せる。
test("PreDecodeDelayQueue: 遅延 0 では積んだ直後に取り出せる", () => {
  const queue = new PreDecodeDelayQueue<string>({ delayMs: 0 });
  queue.push("a", 1, 5_000);

  assert.equal(queue.nextDueMs(), 5_000);
  assert.deepEqual(queue.takeDue(5_000), ["a"]);
});

// 保持できる時間 (上限 / ビットレート) が遅延より短い構成でも、上限超過が続く間は
// 取り出し続ける。落とした分だけ実効的な遅延を短くして、復号が止まらないようにする。
test("PreDecodeDelayQueue: 上限超過が続いても取り出し続ける", () => {
  // 20 バイトを 10 ms ごとに積む。100 バイト (5 件) しか保持できないため、保持できるのは
  // 50 ms 分であり、1,000 ms の遅延より短い
  const queue = new PreDecodeDelayQueue<string>({ delayMs: 1_000, maxBytes: 100 });
  const taken: string[] = [];
  for (let index = 0; index < 100; index++) {
    const nowMs = index * 10;
    queue.push(`object-${index}`, 20, nowMs);
    taken.push(...queue.takeDue(nowMs));
  }

  assert.isAbove(taken.length, 0, "上限超過が続いても取り出すこと");
  // 取り出した順序は積んだ順のままである
  const takenIndexes = taken.map((item) => Number(item.replace("object-", "")));
  for (let index = 1; index < takenIndexes.length; index++) {
    assert.isAbove(
      takenIndexes[index] ?? 0,
      takenIndexes[index - 1] ?? 0,
      "積んだ順に取り出すこと",
    );
  }
  assert.isAtMost(queue.size, 5, "上限を超えて保持しないこと");
});

// 上限超過で短くした遅延は、キューが空になったら元の遅延へ戻る。
test("PreDecodeDelayQueue: 上限超過で短くなった遅延は空になった後に戻る", () => {
  const queue = new PreDecodeDelayQueue<string>({ delayMs: 1_000, maxBytes: 100 });
  for (let index = 0; index < 100; index++) {
    queue.push(`object-${index}`, 20, index * 10);
  }

  // 本来の期限 (積んだ時刻 + 1,000 ms) より前に取り出せる = 遅延が短くなっている
  const nextDueMs = queue.nextDueMs();
  assert.isNotNull(nextDueMs);
  assert.isBelow(nextDueMs ?? Number.POSITIVE_INFINITY, 99 * 10 + 1_000, "遅延が短くなること");

  // すべて取り出して空にすると短縮は解除され、次の Object は元の遅延で待つ
  queue.takeDue(1_000_000);
  assert.equal(queue.size, 0);
  queue.push("after", 20, 2_000_000);
  assert.equal(queue.nextDueMs(), 2_001_000, "空になった後は元の遅延に戻ること");
  assert.deepEqual(queue.takeDue(2_000_999), [], "元の期限の前では取り出さないこと");
  assert.deepEqual(queue.takeDue(2_001_000), ["after"], "元の期限で取り出すこと");
});

// 上限超過の直後に積んだ Object も、短縮した期限で取り出せる (設定遅延まで待たない)。
test("PreDecodeDelayQueue: 上限超過の直後に積んだ Object を短縮した期限で取り出す", () => {
  const queue = new PreDecodeDelayQueue<string>({ delayMs: 1_000, maxBytes: 50 });
  // 20 バイトを 10 ms 間隔で積む。3 件目で上限超過する
  queue.push("a", 20, 0);
  queue.push("b", 20, 10);
  queue.push("c", 20, 20);

  // 上限超過で先頭 (b) の期限が t=20 へ前倒しされている
  assert.deepEqual(queue.takeDue(20), ["b"], "上限超過で先頭の期限が前倒しされること");
  // 短縮中に積んだ c の期限も前倒しされており、設定遅延 (1,000 ms) は待たない
  assert.equal(queue.nextDueMs(), 30, "短縮中に積んだ Object の期限も前倒しされること");
  assert.deepEqual(queue.takeDue(30), ["c"], "短縮した期限で取り出せること");
});

// キューが空になったら短縮を解除し、次の Object は元の遅延で待つ。
test("PreDecodeDelayQueue: 空になったら短縮を解除する", () => {
  const queue = new PreDecodeDelayQueue<string>({ delayMs: 1_000, maxBytes: 50 });
  queue.push("a", 20, 0);
  queue.push("b", 20, 10);
  queue.push("c", 20, 20);
  queue.takeDue(20);
  queue.takeDue(30);
  assert.equal(queue.size, 0);

  queue.push("d", 20, 1_000);
  assert.equal(queue.nextDueMs(), 2_000, "空になった後は元の遅延で待つこと");
  assert.deepEqual(queue.takeDue(1_999), [], "元の期限の前では取り出さないこと");
  assert.deepEqual(queue.takeDue(2_000), ["d"], "元の期限で取り出すこと");
  assert.equal(queue.delayShortenMs, 0, "短縮が解除されていること");
});

// 上限超過の同期で短縮量を外から設定しても、保持中の Object を追い越さない (積んだ順を守る)。
test("PreDecodeDelayQueue: setDelayShortenMs で短縮しても積んだ順を守る", () => {
  const queue = new PreDecodeDelayQueue<string>({ delayMs: 1_000, maxBytes: 1_000 });
  queue.push("old-1", 1, 0);
  queue.push("old-2", 1, 5);
  // もう一方のメディアの上限超過に合わせて短縮する (以後に積む Object が短い遅延になる)
  queue.setDelayShortenMs(900);
  queue.push("new-1", 1, 10);

  // 先頭 (old-1) が未期限の間は、期限の早い new-1 を追い越さない
  assert.deepEqual(queue.takeDue(200), [], "先頭が未期限なら後ろの Object を取り出さないこと");
  assert.equal(queue.nextDueMs(), 1_000, "先頭の期限を次に待つこと");
  assert.deepEqual(queue.takeDue(1_000), ["old-1"], "先頭から順に取り出すこと");
  assert.deepEqual(queue.takeDue(1_005), ["old-2", "new-1"], "残りを積んだ順に取り出すこと");
});

// 遅延の値が不正なら生成時にエラーにする。
test("PreDecodeDelayQueue: 不正な遅延は生成時にエラーにする", () => {
  assert.throws(
    () => new PreDecodeDelayQueue<string>({ delayMs: -1 }),
    /delayMs must be a finite number >= 0/,
  );
  assert.throws(
    () => new PreDecodeDelayQueue<string>({ delayMs: Number.NaN }),
    /delayMs must be a finite number >= 0/,
  );
  assert.throws(
    () => new PreDecodeDelayQueue<string>({ delayMs: Number.POSITIVE_INFINITY }),
    /delayMs must be a finite number >= 0/,
  );
});

// バイト数が不正なら push 時にエラーにする。
test("PreDecodeDelayQueue: 不正なバイト数は push 時にエラーにする", () => {
  const queue = makeQueue();
  assert.throws(() => queue.push("a", -1, 1_000), /bytes must be a finite number >= 0/);
  assert.throws(() => queue.push("a", Number.NaN, 1_000), /bytes must be a finite number >= 0/);
});

// 定数の関係を固定する。遅延の上限は 2 秒以上を含む。
test("PreDecodeDelayQueue: 遅延の上限は 2 秒以上である", () => {
  assert.isAtLeast(MAX_PRE_DECODE_DELAY_MS, 2_000);
});

// 遅延を後から大きくすると、保持中の Object の期限も新しい値で計算し直す。
test("PreDecodeDelayQueue: setDelayMs で保持中の期限を後ろへ伸ばす", () => {
  const queue = makeQueue();
  queue.push("a", 1, 1_000);

  queue.setDelayMs(5_000);

  assert.equal(queue.delayMs, 5_000);
  assert.equal(queue.nextDueMs(), 6_000);
  assert.deepEqual(queue.takeDue(5_999), [], "新しい期限の前では取り出さないこと");
  assert.deepEqual(queue.takeDue(6_000), ["a"]);
});

// 遅延を後から小さくすると、期限が早まり、期限を過ぎた Object はすぐに取り出せる。
test("PreDecodeDelayQueue: setDelayMs で保持中の期限を前へ縮める", () => {
  const queue = makeQueue();
  queue.push("a", 1, 1_000);

  queue.setDelayMs(500);

  assert.equal(queue.nextDueMs(), 1_500);
  assert.deepEqual(queue.takeDue(1_500), ["a"]);
});

// 遅延を変えても、保持している Object の順序は積んだ順のままである。
test("PreDecodeDelayQueue: setDelayMs しても Object の順序を変えない", () => {
  const queue = makeQueue();
  queue.push("a", 1, 1_000);
  queue.push("b", 1, 1_100);
  queue.push("c", 1, 1_200);

  queue.setDelayMs(100);

  assert.deepEqual(queue.takeDue(1_300), ["a", "b", "c"]);
});

// takeAll は期限を待たずにすべて取り出し、件数とバイト数を戻す。
test("PreDecodeDelayQueue: takeAll で期限を待たずに取り出す", () => {
  const queue = makeQueue();
  queue.push("a", 3, 1_000);
  queue.push("b", 4, 1_000);

  const items = queue.takeAll();

  assert.deepEqual(items, ["a", "b"]);
  assert.equal(queue.size, 0);
  assert.equal(queue.bufferedBytes, 0);
  assert.isNull(queue.nextDueMs());
  assert.deepEqual(queue.takeAll(), [], "空のときは空配列を返すこと");
});

// setDelayMs の値も生成時と同じ規則で検証する。
test("PreDecodeDelayQueue: setDelayMs の不正値を拒否する", () => {
  const queue = makeQueue();
  assert.throws(() => queue.setDelayMs(-1), /delayMs must be a finite number >= 0/);
  assert.throws(() => queue.setDelayMs(Number.NaN), /delayMs must be a finite number >= 0/);
  assert.throws(
    () => queue.setDelayMs(Number.POSITIVE_INFINITY),
    /delayMs must be a finite number >= 0/,
  );
  assert.throws(
    () => queue.setDelayMs(MAX_PRE_DECODE_DELAY_MS + 1),
    /delayMs must be <=/,
    "上限を超える遅延を拒否すること",
  );
});

// 生成時も上限を超える遅延を拒否する。
test("PreDecodeDelayQueue: 上限を超える遅延は生成時に拒否する", () => {
  assert.throws(
    () => new PreDecodeDelayQueue<string>({ delayMs: MAX_PRE_DECODE_DELAY_MS + 1 }),
    /delayMs must be <=/,
  );
});
