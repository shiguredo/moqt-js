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
    logSequence.value;
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
