/**
 * PreDecodeDelayStage (復号前の遅延の段) の単体テスト
 *
 * 決定的な時計とタイマーを渡し、実時間を待たずに次の性質を確かめる。
 *
 * - 期限が来るまで期限の通知をせず、期限が来たら積んだ順にまとめて通知する
 * - 遅延を変えると保持中の Object の期限を計算し直してタイマーを張り直す
 * - flush は期限を待たずにすべて通知し、stop はタイマーとキューを破棄する
 * - 上限超過は段を作り直すまで 1 回だけ通知し、上限超過が続いても通知を止まらない
 * - 期限の通知が throw しても、次の期限のタイマーは張り直す
 *
 * 個々の期限の計算 (境界値・順序・バイト数) は src/playout/preDecodeDelay.test.ts が持つ。
 */

import { test, assert } from "vite-plus/test";
import { PreDecodeDelayStage, type PreDecodeDelayStageOverflow } from "./preDecodeDelayStage";
import { FakePreDecodeDelayClock } from "../testSupport/fakeClock";

/** 文字列のバイト数を文字数として数える (テスト用) */
function bytesOfString(item: string): number {
  return item.length;
}

/** 段と、期限の通知を受けた Object の記録を作る */
function makeStage(
  options: {
    delayMs?: number;
    maxBytes?: number;
    maxObjects?: number;
    bytesOf?: (item: string) => number;
    onDueError?: (error: unknown) => void;
  } = {},
): {
  stage: PreDecodeDelayStage<string>;
  clock: FakePreDecodeDelayClock;
  due: string[][];
  overflows: PreDecodeDelayStageOverflow[];
} {
  const clock = new FakePreDecodeDelayClock();
  const due: string[][] = [];
  const overflows: PreDecodeDelayStageOverflow[] = [];
  const stage = new PreDecodeDelayStage<string>({
    delayMs: options.delayMs ?? 100,
    ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
    ...(options.maxObjects === undefined ? {} : { maxObjects: options.maxObjects }),
    bytesOf: options.bytesOf ?? bytesOfString,
    clock,
    onDue: (items) => {
      due.push([...items]);
    },
    onOverflow: (overflow) => {
      overflows.push(overflow);
    },
    ...(options.onDueError === undefined ? {} : { onDueError: options.onDueError }),
  });
  return { stage, clock, due, overflows };
}

// 期限の 1 ms 前まで通知せず、期限ちょうどで通知する。
test("PreDecodeDelayStage: 期限まで通知せず、期限でまとめて通知する", () => {
  const { stage, clock, due } = makeStage({ delayMs: 100 });
  stage.push("a");
  stage.push("b");

  clock.advance(99);
  assert.deepEqual(due, [], "期限の 1 ms 前では通知しないこと");

  clock.advance(1);
  assert.deepEqual(due, [["a", "b"]], "期限ちょうどで積んだ順にまとめて通知すること");
  assert.equal(stage.size, 0);
});

// 遅延を大きくすると、保持中の Object の期限も後ろへ伸びる。
test("PreDecodeDelayStage: setDelayMs で期限を後ろへ伸ばす", () => {
  const { stage, clock, due } = makeStage({ delayMs: 100 });
  stage.push("a");
  clock.advance(50);
  stage.setDelayMs(500);

  clock.advance(400);
  assert.deepEqual(due, [], "変更後の期限の前では通知しないこと");

  clock.advance(100);
  assert.deepEqual(due, [["a"]], "変更後の期限で通知すること");
});

// 遅延を小さくすると、保持中の Object の期限が早まり、タイマーも張り直される。
test("PreDecodeDelayStage: setDelayMs で期限を前へ縮める", () => {
  const { stage, clock, due } = makeStage({ delayMs: 500 });
  stage.push("a");
  clock.advance(100);
  stage.setDelayMs(50);

  clock.advance(50);
  assert.deepEqual(due, [["a"]], "変更後の期限で通知すること");
});

// flush は期限を待たずにすべて通知し、タイマーを残さない。
test("PreDecodeDelayStage: flush で期限を待たずに通知する", () => {
  const { stage, clock, due } = makeStage({ delayMs: 1_000 });
  stage.push("a");
  stage.push("b");

  stage.flush();

  assert.deepEqual(due, [["a", "b"]], "積んだ順にすべて通知すること");
  assert.equal(stage.size, 0);
  assert.equal(clock.pendingTimerCount, 0, "タイマーを残さないこと");
  clock.advance(2_000);
  assert.deepEqual(due, [["a", "b"]], "flush の後に再度通知しないこと");
});

// stop はタイマーとキューを破棄し、期限が来ても通知しない。
test("PreDecodeDelayStage: stop でタイマーとキューを破棄する", () => {
  const { stage, clock, due } = makeStage({ delayMs: 100 });
  stage.push("a");

  stage.stop();

  assert.equal(stage.size, 0);
  assert.equal(clock.pendingTimerCount, 0, "タイマーを残さないこと");
  clock.advance(1_000);
  assert.deepEqual(due, [], "停止後に通知しないこと");
});

// 上限超過は 1 回だけ通知し、resetOverflowNotification で解除できる。
test("PreDecodeDelayStage: 上限超過は 1 回だけ通知する", () => {
  const { stage, overflows } = makeStage({ delayMs: 100, maxObjects: 1 });
  stage.push("a");
  stage.push("b");
  stage.push("c");

  assert.equal(overflows.length, 1, "購読期間あたり 1 回だけ通知すること");
  assert.equal(overflows[0]?.dropped, 1, "落とした件数を通知すること");
  assert.equal(stage.size, 1);

  stage.resetOverflowNotification();
  stage.push("d");

  assert.equal(overflows.length, 2, "解除後は改めて通知すること");
});

// 上限超過が起きたら、元の期限を待たずに前倒しした期限で通知する。タイマーを張り直さない
// と、元の期限 (遅延の分) まで復号が止まり、その間も古い Object を落とし続ける。
test("PreDecodeDelayStage: 上限超過の直後に前倒しした期限で通知する", () => {
  // 1 件 20 バイトで 50 バイトまでしか保持できないため、3 件目で上限超過する
  const { stage, clock, due } = makeStage({
    delayMs: 1_000,
    maxBytes: 50,
    maxObjects: 0,
    bytesOf: () => 20,
  });
  stage.push("a");
  clock.advance(10);
  stage.push("b");
  clock.advance(10);
  stage.push("c");

  // 3 件目の push で上限超過し、残りの期限が前倒しされる
  clock.advance(10);
  assert.isAbove(due.flat().length, 0, "元の期限 (1,000 ms) を待たずに通知すること");
  assert.isBelow(clock.now(), 1_000, "元の期限より前に通知すること");
});

// 上限超過が続いても、期限の来た Object を通知し続ける (キューが詰まらない)。
test("PreDecodeDelayStage: 上限超過が続いても通知し続ける", () => {
  // 1 件 20 バイトで 50 バイトまでしか保持できない。遅延は 1,000 ms ある
  const { stage, clock, due } = makeStage({
    delayMs: 1_000,
    maxBytes: 50,
    maxObjects: 0,
    bytesOf: () => 20,
  });
  for (let index = 0; index < 100; index++) {
    stage.push(`object-${index}`);
    clock.advance(10);
  }

  const notified = due.flat();
  assert.isAbove(notified.length, 0, "上限超過が続いても通知すること");
  // 通知の順序は積んだ順のままである
  const notifiedIndexes = notified.map((item) => Number(item.replace("object-", "")));
  for (let index = 1; index < notifiedIndexes.length; index++) {
    assert.isAbove(
      notifiedIndexes[index] ?? 0,
      notifiedIndexes[index - 1] ?? 0,
      "積んだ順に通知すること",
    );
  }
  assert.isAtMost(stage.size, 3, "上限を超えて保持しないこと");
});

// 期限の通知が throw しても、次の期限のタイマーは張り直す。
test("PreDecodeDelayStage: 期限の通知の失敗後も次の期限を待つ", () => {
  const errors: unknown[] = [];
  const clock = new FakePreDecodeDelayClock();
  const due: string[][] = [];
  const stage = new PreDecodeDelayStage<string>({
    delayMs: 100,
    bytesOf: bytesOfString,
    clock,
    onDue: (items) => {
      due.push([...items]);
      throw new Error("due callback failed");
    },
    onDueError: (error) => {
      errors.push(error);
    },
  });

  stage.push("a");
  clock.advance(100);
  assert.equal(errors.length, 1, "通知の失敗を onDueError へ流すこと");

  stage.push("b");
  clock.advance(100);
  assert.deepEqual(due, [["a"], ["b"]], "次の期限も通知すること");
});

// 積んだ順 (期限の昇順) に通知する。
test("PreDecodeDelayStage: 期限の昇順に通知する", () => {
  const { stage, clock, due } = makeStage({ delayMs: 100 });
  stage.push("1 件目");
  clock.advance(10);
  stage.push("2 件目");

  // 1 件目の期限 100 ms で通知し、2 件目の期限 110 ms も同じ advance の中で通知する
  clock.advance(100);
  assert.deepEqual(due, [["1 件目"], ["2 件目"]], "期限の昇順に通知すること");
});

// 実装のクラスが公開している遅延と件数はキューの値と一致する。
test("PreDecodeDelayStage: delayMs / size / bufferedBytes はキューの値を返す", () => {
  const { stage } = makeStage({ delayMs: 100 });
  assert.equal(stage.delayMs, 100);
  stage.push("abc");
  assert.equal(stage.size, 1);
  assert.equal(stage.bufferedBytes, 3);
  stage.setDelayMs(250);
  assert.equal(stage.delayMs, 250);
});

// 上限超過の判定はキューと同じ規則である (上限 0 以下は無制限)。
test("PreDecodeDelayStage: 上限に 0 以下を指定したら無制限にする", () => {
  const { stage, overflows, clock } = makeStage({ delayMs: 100, maxObjects: 0, maxBytes: 0 });
  for (let index = 0; index < 20; index++) {
    stage.push(`object-${index}`);
  }
  assert.equal(overflows.length, 0, "無制限なら超過しないこと");
  assert.equal(stage.size, 20);
  clock.advance(100);
});

// キュー (PreDecodeDelayQueue) との整合: 段の件数はキューと同じ上限に従う。
test("PreDecodeDelayStage: 件数上限で古い Object を落とす", () => {
  const { stage, overflows } = makeStage({ delayMs: 100, maxObjects: 2 });
  stage.push("a");
  stage.push("b");
  stage.push("c");
  assert.equal(stage.size, 2);
  assert.equal(overflows.length, 1);
});

// PreDecodeDelayQueue の既定の上限を段も使う (バイト数を渡さない経路は無い)。
test("PreDecodeDelayStage: キューのバイト数は bytesOf の合計になる", () => {
  const { stage } = makeStage({ delayMs: 100 });
  stage.push("ab");
  stage.push("cde");
  assert.equal(stage.bufferedBytes, 5);
});

// キューが空になったら短縮を解除し、次の Object は元の遅延で待つ。
test("PreDecodeDelayStage: キューが空になったら短縮を解除する", () => {
  const { stage, clock, due } = makeStage({
    delayMs: 1_000,
    maxBytes: 50,
    maxObjects: 0,
    bytesOf: () => 20,
  });
  stage.push("a");
  clock.advance(10);
  stage.push("b");
  clock.advance(10);
  stage.push("c");
  // 前倒しされた期限で通知し、キューが空になる
  clock.advance(20);
  assert.isAbove(due.flat().length, 0);
  assert.equal(stage.size, 0);

  // 空になった後の Object は元の遅延 (1,000 ms) で待つ
  stage.push("d");
  clock.advance(999);
  assert.equal(due.flat().includes("d"), false, "空になった後は元の遅延の前では通知しないこと");
  clock.advance(1);
  assert.isTrue(due.flat().includes("d"), "元の期限で通知すること");
});
