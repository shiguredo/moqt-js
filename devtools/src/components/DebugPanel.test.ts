import { test, assert, beforeEach } from "vite-plus/test";
import { effect } from "@preact/signals";
import {
  addLog,
  autoScroll,
  getLogBuffer,
  logCount,
  logSequence,
  __resetLogStateForTest,
} from "./DebugPanel";

const MAX_LOGS = 1000;

beforeEach(() => {
  __resetLogStateForTest();
  autoScroll.value = true;
});

test("addLog appends entries and bumps logCount / logSequence", () => {
  addLog("info", "a");
  addLog("info", "b");
  assert.equal(getLogBuffer().length, 2);
  assert.equal(logCount.value, 2);
  assert.equal(logSequence.value, 2);
});

test("addLog caps logBuffer at MAX_LOGS but logSequence keeps growing", () => {
  for (let i = 0; i < MAX_LOGS + 1; i++) {
    addLog("info", `msg-${i}`);
  }
  assert.equal(getLogBuffer().length, MAX_LOGS);
  assert.equal(logCount.value, MAX_LOGS);
  assert.equal(logSequence.value, MAX_LOGS + 1);
});

test("addLog logSequence monotonically increases past MAX_LOGS", () => {
  for (let i = 0; i < MAX_LOGS * 2; i++) {
    addLog("info", `msg-${i}`);
  }
  assert.equal(getLogBuffer().length, MAX_LOGS);
  assert.equal(logCount.value, MAX_LOGS);
  assert.equal(logSequence.value, MAX_LOGS * 2);
});

test("logSequence does not fire on autoScroll toggle but fires on addLog", () => {
  let fireCount = 0;
  const dispose = effect(() => {
    // signal を参照して effect の依存として登録する (値自体は使わない)
    void logSequence.value;
    fireCount += 1;
  });
  try {
    // 初回登録時に 1 回発火。
    assert.equal(fireCount, 1);
    autoScroll.value = false;
    autoScroll.value = true;
    assert.equal(fireCount, 1);
    addLog("info", "test");
    assert.equal(fireCount, 2);
    addLog("info", "test");
    assert.equal(fireCount, 3);
  } finally {
    dispose();
  }
});

test("addLog: 表示の key に使う連番は上限に達しても重複しない", () => {
  // 表示の key と展開状態の識別に使う連番。配列の添字を使うと、上限に達して
  // 最古を捨てたときに展開状態が別の行へ移る
  const appendedCount = MAX_LOGS + 10;
  for (let i = 0; i < appendedCount; i++) {
    addLog("info", `msg-${i}`);
  }

  const ids = getLogBuffer().map((entry) => entry.id);
  assert.equal(ids.length, MAX_LOGS);
  // 連番は重複しない (同じ id の行が 2 つできると key が衝突する)
  assert.equal(new Set(ids).size, ids.length);
  // 残っているのは新しい MAX_LOGS 件であり、古い方は捨てられている
  assert.equal(getLogBuffer()[0]?.message, `msg-${appendedCount - MAX_LOGS}`);
  assert.equal(getLogBuffer().at(-1)?.message, `msg-${appendedCount - 1}`);
});
