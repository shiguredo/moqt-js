/**
 * MOQLOG (Log track payload) Unit Tests
 * draft-jennings-moq-log-03 Section 4 / Section 7
 * draft-ietf-moq-msf-01 §9
 */

import { test, assert } from "vite-plus/test";
import {
  type LogEntry,
  type LogSeverity,
  encodeLogEntry,
  decodeLogEntry,
  createLogGroupId,
  createLogObjectId,
  buildLogTrackNamespace,
  buildLogTrackName,
  severityToLevel,
  levelToSeverity,
} from "./moqlog";

// ============================================================
// encode / decode round-trip
// ============================================================

// [MOQLOG] §7 の例をテストベクタとして使用する
test("MOQLOG: §7 の例を round-trip できる", () => {
  const entry: LogEntry = {
    timestamp: 3155587200,
    severity: "Info",
    msg: "shutting down forY2K",
  };
  const encoded = encodeLogEntry(entry);
  const decoded = decodeLogEntry(encoded);
  assert.equal(decoded.timestamp, 3155587200);
  assert.equal(decoded.severity, "Info");
  assert.equal(decoded.msg, "shutting down forY2K");
});

// 全フィールド指定の round-trip
test("MOQLOG: 全フィールド指定で round-trip できる", () => {
  const entry: LogEntry = {
    severity: "Error",
    timestamp: 1000000,
    pri: 11,
    hostname: "server01",
    appname: "myapp",
    procid: "1234",
    msgid: "MSG001",
    msg: "something went wrong",
  };
  const encoded = encodeLogEntry(entry);
  const decoded = decodeLogEntry(encoded);
  assert.equal(decoded.severity, "Error");
  assert.equal(decoded.timestamp, 1000000);
  assert.equal(decoded.pri, 11);
  assert.equal(decoded.hostname, "server01");
  assert.equal(decoded.appname, "myapp");
  assert.equal(decoded.procid, "1234");
  assert.equal(decoded.msgid, "MSG001");
  assert.equal(decoded.msg, "something went wrong");
});

// 空エントリの round-trip
test("MOQLOG: 空エントリは {} にエンコードされる", () => {
  const entry: LogEntry = {};
  const encoded = encodeLogEntry(entry);
  const decoded = decodeLogEntry(encoded);
  assert.isUndefined(decoded.severity);
  assert.isUndefined(decoded.msg);
});

// 未知フィールド（structured data）が round-trip で保持される
test("MOQLOG: 未知フィールドが round-trip で保持される", () => {
  const entry: LogEntry = {
    severity: "Debug",
    msg: "trace",
    TraceID: "abc123",
    SpanID: "def456",
    customAttr: 42,
  };
  const encoded = encodeLogEntry(entry);
  const decoded = decodeLogEntry(encoded);
  assert.equal(decoded.severity, "Debug");
  assert.equal(decoded.TraceID, "abc123");
  assert.equal(decoded.SpanID, "def456");
  assert.equal(decoded.customAttr, 42);
});

// ============================================================
// Group ID / Object ID helper (msf-01 §9.3)
// ============================================================

// Group ID は Unix epoch マイクロ秒を 62-bit に truncate する
test("MOQLOG: createLogGroupId は 62-bit に truncate する", () => {
  // 2^62 = 4611686018427387904
  const timestamp = (1n << 62n) + 12345n;
  const groupId = createLogGroupId(timestamp);
  assert.equal(groupId, 12345n);
});

// 通常のタイムスタンプはそのまま通る
test("MOQLOG: createLogGroupId は 62-bit 以内の値をそのまま返す", () => {
  // 2026-01-01T00:00:00Z のマイクロ秒 (概算)
  const timestamp = 1767225600000000n;
  const groupId = createLogGroupId(timestamp);
  assert.equal(groupId, timestamp);
});

// Object ID は同一マイクロ秒内の連番
test("MOQLOG: createLogObjectId は連番を返す", () => {
  assert.equal(createLogObjectId(0), 0);
  assert.equal(createLogObjectId(1), 1);
  assert.equal(createLogObjectId(5), 5);
});

// ============================================================
// Namespace / Track Name helper
// ============================================================

// [MOQLOG] §3 の namespace 形式
test("MOQLOG: buildLogTrackNamespace は [MOQLOG] §3 の形式を返す", () => {
  const ns = buildLogTrackNamespace("server01");
  assert.deepEqual(ns, ["moq://moq-syslog.arpa/logs-v1/", "server01"]);
});

// Track Name は priority level の 1 バイト
test("MOQLOG: buildLogTrackName は level の 1 バイトを返す", () => {
  const name = buildLogTrackName(6);
  assert.equal(name.length, 1);
  assert.equal(name[0], 6);
});

// Track Name の範囲外は throw
test("MOQLOG: buildLogTrackName は 0-7 以外で throw する", () => {
  assert.throws(() => buildLogTrackName(-1), "log priority level must be 0-7");
  assert.throws(() => buildLogTrackName(8), "log priority level must be 0-7");
});

// ============================================================
// severity <-> level 変換
// ============================================================

test("MOQLOG: severityToLevel は正しい level を返す", () => {
  assert.equal(severityToLevel("Emergency"), 0);
  assert.equal(severityToLevel("Alert"), 1);
  assert.equal(severityToLevel("Critical"), 2);
  assert.equal(severityToLevel("Error"), 3);
  assert.equal(severityToLevel("Warning"), 4);
  assert.equal(severityToLevel("Notice"), 5);
  assert.equal(severityToLevel("Info"), 6);
  assert.equal(severityToLevel("Debug"), 7);
});

test("MOQLOG: levelToSeverity は正しい severity を返す", () => {
  assert.equal(levelToSeverity(0), "Emergency");
  assert.equal(levelToSeverity(3), "Error");
  assert.equal(levelToSeverity(6), "Info");
  assert.equal(levelToSeverity(7), "Debug");
});

test("MOQLOG: levelToSeverity は範囲外で throw する", () => {
  assert.throws(() => levelToSeverity(-1), "log priority level must be 0-7");
  assert.throws(() => levelToSeverity(8), "log priority level must be 0-7");
});

// severity <-> level の往復変換
test("MOQLOG: severity <-> level の往復変換が一致する", () => {
  const severities: LogSeverity[] = [
    "Emergency",
    "Alert",
    "Critical",
    "Error",
    "Warning",
    "Notice",
    "Info",
    "Debug",
  ];
  for (const s of severities) {
    assert.equal(levelToSeverity(severityToLevel(s)), s);
  }
});
