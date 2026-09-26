import { test, assert, beforeEach } from "vite-plus/test";
import { effect } from "@preact/signals";
import {
  MAX_LOGS,
  __resetLogStateForTest,
  addLog,
  clearLog,
  getLogBuffer,
  logSequence,
} from "./debugLog";
import { autoScroll } from "./debug";

// 表示用の文字列の形。追加時に整形した値がその形であることを確かめる
const ABSOLUTE_TIME_PATTERN = /^\d{2}:\d{2}:\d{2}\.\d{3}$/;
const ELAPSED_TIME_PATTERN = /^\+\d+\.\d{3}$/;
const DELTA_TIME_PATTERN = /^\(\+\d+ms\)$/;

beforeEach(() => {
  __resetLogStateForTest();
  autoScroll.value = true;
});

test("addLog: 追加した件数だけログが溜まり、連番が進む", () => {
  addLog("info", "a");
  addLog("info", "b");

  assert.equal(getLogBuffer().length, 2);
  assert.equal(logSequence.value, 2);
  assert.equal(getLogBuffer()[0]?.message, "a");
  assert.equal(getLogBuffer()[1]?.message, "b");
});

test("addLog: 表示用の時刻を追加時に 1 回だけ整形して持つ", () => {
  // 描画のたびに整形し直すと、1 件追加するたびのコストが表示中の件数に比例する。
  // 経過時間と差分も含めて追加時に作っておく
  addLog("info", "first");
  addLog("warn", "second", { index: 2 });

  const [first, second] = getLogBuffer();
  assert.isDefined(first);
  assert.isDefined(second);
  assert.match(first.formattedTimestamp, ABSOLUTE_TIME_PATTERN);
  assert.match(first.formattedElapsed, ELAPSED_TIME_PATTERN);
  assert.match(second.formattedTimestamp, ABSOLUTE_TIME_PATTERN);
  assert.match(second.formattedElapsed, ELAPSED_TIME_PATTERN);
  assert.match(second.formattedDelta, DELTA_TIME_PATTERN);
});

test("addLog: 最初のログの経過時間は 0 で、差分は出さない", () => {
  // 経過時間の基準は最初に追加したログ自身のため 0 になる。時系列で 1 つ前のログが
  // 無いため差分は空文字にする
  addLog("info", "only");

  const [only] = getLogBuffer();
  assert.isDefined(only);
  assert.equal(only.formattedElapsed, "+0.000");
  assert.equal(only.formattedDelta, "");
});

test("addLog: 差分は時系列で 1 つ前のログとの差になる", () => {
  // 表示は新しい順に並べるため、行の差分は「表示で次の行」ではなく
  // 「時系列で 1 つ前」との差でなければならない
  addLog("info", "oldest");
  addLog("info", "middle");
  addLog("info", "newest");

  const [oldest, middle, newest] = getLogBuffer();
  assert.isDefined(oldest);
  assert.isDefined(middle);
  assert.isDefined(newest);
  assert.equal(oldest.formattedDelta, "");
  assert.equal(middle.formattedDelta, `(+${middle.timestamp - oldest.timestamp}ms)`);
  assert.equal(newest.formattedDelta, `(+${newest.timestamp - middle.timestamp}ms)`);
});

test("addLog: 上限に達しても経過時間の基準は動かず、既存の行の表示は変わらない", () => {
  // 基準を「残っている最も古いログ」にすると、上限到達で最古を捨てるたびに
  // 表示中の全行の経過時間が変わり、行の表示を作り直す必要が出る。
  // 基準はログを消すまで動かさない
  for (let i = 0; i < MAX_LOGS; i++) {
    addLog("info", `msg-${i}`);
  }
  const beforeDrop = getLogBuffer()[1];
  assert.isDefined(beforeDrop);
  const elapsedBeforeDrop = beforeDrop.formattedElapsed;
  const deltaBeforeDrop = beforeDrop.formattedDelta;

  addLog("info", "overflow");

  assert.equal(getLogBuffer().length, MAX_LOGS);
  // 先頭が 1 つ繰り上がり、捨てられていない行の表示は同じ値のまま
  assert.equal(getLogBuffer()[0]?.message, beforeDrop.message);
  assert.equal(getLogBuffer()[0]?.formattedElapsed, elapsedBeforeDrop);
  assert.equal(getLogBuffer()[0]?.formattedDelta, deltaBeforeDrop);
});

test("addLog: 上限を超えたら最古を捨て、連番は進み続ける", () => {
  const appendedCount = MAX_LOGS * 2;
  for (let i = 0; i < appendedCount; i++) {
    addLog("info", `msg-${i}`);
  }

  assert.equal(getLogBuffer().length, MAX_LOGS);
  assert.equal(logSequence.value, appendedCount);
  assert.equal(getLogBuffer()[0]?.message, `msg-${appendedCount - MAX_LOGS}`);
  assert.equal(getLogBuffer().at(-1)?.message, `msg-${appendedCount - 1}`);
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
  assert.equal(new Set(ids).size, ids.length);
});

test("addLog: data と payload は渡したときだけ載る", () => {
  // exactOptionalPropertyTypes のため undefined を載せない。コピー時に
  // 「data があるか」で表示を分けるため、有無がそのまま意味を持つ
  addLog("info", "no-data");
  addLog("info", "with-data", { index: 1 });
  addLog("info", "with-payload", undefined, new Uint8Array([1, 2, 3]));

  const [noData, withData, withPayload] = getLogBuffer();
  assert.isDefined(noData);
  assert.isDefined(withData);
  assert.isDefined(withPayload);
  assert.notProperty(noData, "data");
  assert.notProperty(noData, "payload");
  assert.deepEqual(withData.data, { index: 1 });
  assert.notProperty(withData, "payload");
  assert.notProperty(withPayload, "data");
  assert.deepEqual(withPayload.payload, new Uint8Array([1, 2, 3]));
});

test("clearLog: ログを空にし、次のログを経過時間の基準にする", () => {
  addLog("info", "before");
  clearLog();

  assert.equal(getLogBuffer().length, 0);
  // クリアでも連番を進める (一覧が空になったことを購読側へ伝える)
  assert.equal(logSequence.value, 2);

  addLog("info", "after");
  assert.equal(getLogBuffer()[0]?.formattedElapsed, "+0.000");
});

test("__resetLogStateForTest: 連番も id も初期状態へ戻す", () => {
  // テストごとに初期状態から始められること。id を戻さないと、テストをまたいで
  // 前のテストの id が残る
  addLog("info", "before");
  clearLog();
  __resetLogStateForTest();

  assert.equal(getLogBuffer().length, 0);
  assert.equal(logSequence.value, 0);

  addLog("info", "after");
  assert.equal(getLogBuffer()[0]?.id, 0);
});

test("logSequence: autoScroll の切り替えでは発火せず、追加とクリアで発火する", () => {
  // 一覧は logSequence だけを購読する。autoScroll の切り替えで発火すると、
  // 表示と関係のない再描画が起きる
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
    clearLog();
    assert.equal(fireCount, 3);
  } finally {
    dispose();
  }
});
