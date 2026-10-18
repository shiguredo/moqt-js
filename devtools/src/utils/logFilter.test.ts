import { test, assert } from "vite-plus/test";
import type { LogEntry, LogLevel } from "../signals/debugLog";
import {
  LOG_LEVEL_OPTIONS,
  countMatchingLogEntries,
  createDefaultLogLevels,
  createLogFilter,
  filterLogEntries,
  isLogFilterActive,
  matchesLogFilter,
  normalizeLogQuery,
} from "./logFilter";

/**
 * 絞り込みのテスト用にログ 1 件を作る
 *
 * 絞り込みは addLog が追加時に作った source と searchText だけを見る。
 * 時刻などの表示用の値は判定に使わないため空にしておく。
 */
function makeEntry(
  level: LogLevel,
  message: string,
  source: string | null,
  searchText: string = message.toLowerCase(),
): LogEntry {
  return {
    id: 0,
    timestamp: 0,
    level,
    message,
    source,
    searchText,
    formattedTimestamp: "",
    formattedElapsed: "",
    formattedDelta: "",
  };
}

test("normalizeLogQuery: 前後の空白を落として小文字にする", () => {
  // 検索欄の入力をそのまま扱うと、大文字小文字や前後の空白で一致しなくなる
  assert.equal(normalizeLogQuery("  Request ID  "), "request id");
  assert.equal(normalizeLogQuery(""), "");
});

test("createLogFilter: 検索語を正規化して条件を作る", () => {
  const filter = createLogFilter("  ERROR ", createDefaultLogLevels(), null);
  assert.equal(filter.query, "error");
  assert.isNull(filter.source);
});

test("createDefaultLogLevels: すべての重要度を表示する", () => {
  // 既定では重要度で絞らない。ログを追加しても見えない行を作らない
  const levels = createDefaultLogLevels();
  assert.equal(levels.size, LOG_LEVEL_OPTIONS.length);
  for (const level of LOG_LEVEL_OPTIONS) {
    assert.isTrue(levels.has(level));
  }
});

test("matchesLogFilter: 重要度で絞る", () => {
  const filter = createLogFilter("", new Set<LogLevel>(["error"]), null);
  assert.isTrue(matchesLogFilter(makeEntry("error", "failed", null), filter));
  assert.isFalse(matchesLogFilter(makeEntry("warn", "failed", null), filter));
});

test("matchesLogFilter: 接続元で絞る", () => {
  // source はメッセージ行頭の `[publisher]` / `[subscriber-...]` から取った値
  const filter = createLogFilter("", createDefaultLogLevels(), "publisher");
  assert.isTrue(matchesLogFilter(makeEntry("info", "[publisher] sent", "publisher"), filter));
  assert.isFalse(
    matchesLogFilter(makeEntry("info", "[subscriber-1] received", "subscriber-1"), filter),
  );
  // 接続元が無い行は、接続元で絞ったときは出さない
  assert.isFalse(matchesLogFilter(makeEntry("info", "precondition broken", null), filter));
});

test("matchesLogFilter: 接続元を指定しなければすべての接続元を出す", () => {
  const filter = createLogFilter("", createDefaultLogLevels(), null);
  assert.isTrue(matchesLogFilter(makeEntry("info", "[publisher] sent", "publisher"), filter));
  assert.isTrue(
    matchesLogFilter(makeEntry("info", "[subscriber-1] received", "subscriber-1"), filter),
  );
  assert.isTrue(matchesLogFilter(makeEntry("info", "precondition broken", null), filter));
});

test("matchesLogFilter: 検索語で本文と data の整形結果を探す", () => {
  // searchText はメッセージ本文と data の表示用整形を小文字化して連結したもの。
  // 大文字小文字を区別せず、data の項目でも検索できる
  const entry = makeEntry(
    "info",
    "[publisher] [SEND] SUBSCRIBE",
    "publisher",
    "[publisher] [send] subscribe\nrequest id: 7",
  );
  assert.isTrue(
    matchesLogFilter(entry, createLogFilter("REQUEST ID", createDefaultLogLevels(), null)),
  );
  assert.isTrue(
    matchesLogFilter(entry, createLogFilter("subscribe", createDefaultLogLevels(), null)),
  );
  assert.isFalse(
    matchesLogFilter(entry, createLogFilter("not-found", createDefaultLogLevels(), null)),
  );
});

test("filterLogEntries: 落とすものが無ければ渡された配列をそのまま返す", () => {
  // 参照が変わらないことで、呼び出し側が無駄な再計算を避けられる
  const entries = [makeEntry("info", "a", null), makeEntry("warn", "b", null)];
  const filtered = filterLogEntries(entries, createLogFilter("", createDefaultLogLevels(), null));
  assert.strictEqual(filtered, entries);
});

test("filterLogEntries: 条件に一致するログだけを残す", () => {
  const entries = [
    makeEntry("info", "[publisher] sent", "publisher"),
    makeEntry("warn", "[subscriber-1] warning", "subscriber-1"),
    makeEntry("error", "[subscriber-1] failed", "subscriber-1"),
  ];
  const filtered = filterLogEntries(
    entries,
    createLogFilter("failed", createDefaultLogLevels(), null),
  );
  assert.deepEqual(
    filtered.map((entry) => entry.message),
    ["[subscriber-1] failed"],
  );
});

test("countMatchingLogEntries: 条件に一致する件数を返す", () => {
  const entries = [
    makeEntry("info", "[publisher] sent", "publisher"),
    makeEntry("error", "[publisher] failed", "publisher"),
    makeEntry("error", "[subscriber-1] failed", "subscriber-1"),
  ];
  assert.equal(
    countMatchingLogEntries(entries, createLogFilter("", createDefaultLogLevels(), null)),
    3,
  );
  assert.equal(
    countMatchingLogEntries(
      entries,
      createLogFilter("failed", createDefaultLogLevels(), "publisher"),
    ),
    1,
  );
  assert.equal(
    countMatchingLogEntries(entries, createLogFilter("failed", createDefaultLogLevels(), null)),
    2,
  );
});

test("isLogFilterActive: 既定の条件からの変更を判定する", () => {
  // 絞り込みの結果を画面に出すかの判定に使う
  const defaultLevels = createDefaultLogLevels();
  assert.isFalse(isLogFilterActive(createLogFilter("", defaultLevels, null)));
  assert.isTrue(isLogFilterActive(createLogFilter("error", defaultLevels, null)));
  assert.isTrue(isLogFilterActive(createLogFilter("", new Set<LogLevel>(["info"]), null)));
  assert.isTrue(isLogFilterActive(createLogFilter("", defaultLevels, "publisher")));
});
