import { test, assert } from "vite-plus/test";
import type { LogEntry } from "../signals/debugLog";
import { buildConnectionSettingsSnapshot } from "../signals/connectionSettingsSnapshot";
import { buildPublisherStats, buildSubscriberStats } from "../signals/statsSnapshot";
import { createSubscriberInstance } from "../signals/subscriber";
import {
  buildDebugExportText,
  formatLogEntryText,
  formatLogsSection,
  formatSnapshotSection,
} from "./debugExportText";

// 整形の対象だけを持つログ 1 件を作る (時刻は追加時に整形済みの値を渡す)
function createLogEntry(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    id: 0,
    timestamp: 1_700_000_000_000,
    level: "info",
    message: "message",
    formattedTimestamp: "12:34:56.789",
    formattedElapsed: "+0.000",
    formattedDelta: "",
    ...overrides,
  };
}

test("formatSnapshotSection: 値の型ごとに 1 行ずつ出す", () => {
  // コピー本文は人が読むだけでなく LLM へ渡す。値が無いことと 0 / false を
  // 区別できるようにする
  const section = formatSnapshotSection("Test", {
    integer: 12,
    float: 1.23456,
    tiny: 0.0004,
    text: "value",
    flag: true,
    missing: null,
  });

  assert.equal(
    section,
    [
      "=== Test ===",
      "integer: 12",
      "float: 1.235",
      "tiny: 0",
      "text: value",
      "flag: true",
      "missing: -",
    ].join("\n"),
  );
});

test("formatSnapshotSection: 入れ子のオブジェクトは字下げして出す", () => {
  // 統計は分布 (p50 / p95 / max) や同期の推定のように入れ子を持つ。
  // キーは入れ子のまま出す
  const section = formatSnapshotSection("Test", {
    timing: { p50: 1.5, p95: 20, max: null },
  });

  assert.equal(
    section,
    ["=== Test ===", "timing:", "  p50: 1.5", "  p95: 20", "  max: -"].join("\n"),
  );
});

test("formatSnapshotSection: 配列は単純なら 1 行、オブジェクトを含むなら 1 要素 1 行にする", () => {
  // 止まりや stream reset の履歴はオブジェクトの配列、error code ごとの数は
  // 入れ子のオブジェクトになる
  const section = formatSnapshotSection("Test", {
    codes: { 0x1: 2, 0x2: 1 },
    empty: [],
    resets: [
      { code: 1, count: 2 },
      { code: 3, count: 4 },
    ],
    segments: ["arrival", "hold"],
  });

  assert.equal(
    section,
    [
      "=== Test ===",
      "codes:",
      "  1: 2",
      "  2: 1",
      "empty: []",
      "resets:",
      '  - {"code":1,"count":2}',
      '  - {"code":3,"count":4}',
      'segments: ["arrival","hold"]',
    ].join("\n"),
  );
});

test("formatSnapshotSection: 空のオブジェクトは {} にする", () => {
  assert.equal(formatSnapshotSection("Test", { none: {} }), "=== Test ===\nnone: {}");
});

test("formatLogEntryText: 時刻と本文と data と payload を並べる", () => {
  // 行のコピーと一括コピーは同じ整形を使う。時刻は整形済みの値をそのまま使う
  const entry = createLogEntry({
    message: "[publisher] [SEND] OBJECT",
    data: { requestId: 3 },
    payload: new Uint8Array([0x01, 0x02]),
  });

  const text = formatLogEntryText(entry);

  assert.include(text, "12:34:56.789 [publisher] [SEND] OBJECT");
  assert.include(text, "Request ID: 3");
  assert.include(text, "Binary (2 bytes):");
  assert.include(text, "0000  01 02");
});

test("formatLogEntryText: data と payload が無いログは時刻と本文だけにする", () => {
  assert.equal(formatLogEntryText(createLogEntry({ message: "simple" })), "12:34:56.789 simple");
});

test("formatLogsSection: 見出しに絞り込みを出し、一致するログだけを並べる", () => {
  const logs = [
    createLogEntry({ id: 0, message: "[publisher] [SEND] SETUP" }),
    createLogEntry({ id: 1, message: "[subscriber-1] [RECV] SETUP" }),
  ];

  const filtered = formatLogsSection(logs, "[publisher]");
  assert.isTrue(filtered.startsWith("=== Debug Logs ([publisher]) ==="));
  assert.include(filtered, "[publisher] [SEND] SETUP");
  assert.notInclude(filtered, "[subscriber-1] [RECV] SETUP");

  // 絞り込みが無いときは見出しに何も付けない
  const all = formatLogsSection(logs);
  assert.isTrue(all.startsWith("=== Debug Logs ==="));
  assert.include(all, "[subscriber-1] [RECV] SETUP");
});

test("buildDebugExportText: 接続設定・統計・ログの順に節を並べる", () => {
  const text = buildDebugExportText({
    connection: buildConnectionSettingsSnapshot(),
    publisher: null,
    subscribers: [],
    logs: [createLogEntry({ message: "only log" })],
  });

  // 節の順は接続設定、統計、ログ。設定は実際のスナップショットのキーを出す
  assert.isTrue(text.startsWith("=== Connection Settings ===\nurl: moqt://"));
  assert.include(text, "namespace: room/123");
  assert.isTrue(text.endsWith("=== Debug Logs ===\n12:34:56.789 only log"));
});

test("buildDebugExportText: Publisher の統計が null のときは節を出さない", () => {
  // 配信していないページでは全て 0 の統計を出しても読む側の役に立たない
  const input = {
    connection: buildConnectionSettingsSnapshot(),
    subscribers: [],
    logs: [],
  };

  const withoutPublisher = buildDebugExportText({ ...input, publisher: null });
  assert.notInclude(withoutPublisher, "Publisher Statistics");

  const withPublisher = buildDebugExportText({
    ...input,
    publisher: buildPublisherStats(),
  });
  assert.include(withPublisher, "=== Publisher Statistics ===");
  assert.include(withPublisher, "status: disconnected");
});

test("buildDebugExportText: Subscriber ごとに節を出し、id を見出しに入れる", () => {
  const text = buildDebugExportText({
    connection: buildConnectionSettingsSnapshot(),
    publisher: null,
    subscribers: [
      buildSubscriberStats(createSubscriberInstance("subscriber-1")),
      buildSubscriberStats(createSubscriberInstance("subscriber-2")),
    ],
    logs: [],
  });

  assert.include(text, "=== Subscriber Statistics (subscriber-1) ===");
  assert.include(text, "=== Subscriber Statistics (subscriber-2) ===");
  // 見出しの順は渡した順
  assert.isTrue(text.indexOf("subscriber-1") < text.indexOf("subscriber-2"));
});
