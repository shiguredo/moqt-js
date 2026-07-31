/**
 * MOQ Log (moqlog) の単体テスト
 * draft-jennings-moq-log-03 ([MOQLOG]) / draft-ietf-moq-msf-01 §9 (Log track)
 *
 * 任意の JSON object に対する round-trip は moqlog.prop.ts の PBT で検証する。
 * 本ファイルは §7 ベクタ・空オブジェクト・エラーパス・各 helper の固有挙動を扱う。
 */

import { test, assert } from "vite-plus/test";
import {
  LOG_SEVERITY_LEVELS,
  MOQLOG_NAMESPACE_PREFIX,
  encodeLogEntry,
  decodeLogEntry,
  logGroupId,
  logObjectId,
  logTrackNamespace,
  logTrackName,
} from "./moqlog";

// [MOQLOG] §4: payload は全フィールド optional の JSON object。
// 空の LogEntry（全フィールド欠落）も有効な JSON object として round-trip する。
test("LogEntry: 空オブジェクトの round-trip", () => {
  const decoded = decodeLogEntry(encodeLogEntry({}));
  assert.deepEqual(decoded, {});
});

// [MOQLOG] §7 の例をテストベクタとしてデコードできることを検証する。
// 注意: §7 の例は severity に短縮形 "Info" を使う（§4 本文の正規形 "Informational" と不整合）。
// msg も本文 "shutting down for Y2K" に対し JSON は "shutting down forY2K"（スペース無し）。
// ここでは §7 の JSON 本体を正として round-trip を検証する。
test("LogEntry: [MOQLOG] §7 の例を round-trip する", () => {
  const vector = '{"timestamp":3155587200,"severity":"Info","msg":"shutting down forY2K"}';
  const decoded = decodeLogEntry(new TextEncoder().encode(vector));
  assert.equal(decoded.timestamp, 3155587200);
  assert.equal(decoded.severity, "Info");
  assert.equal(decoded.msg, "shutting down forY2K");

  // round-trip で同一内容が再現する
  const redecoded = decodeLogEntry(encodeLogEntry(decoded));
  assert.equal(redecoded.timestamp, 3155587200);
  assert.equal(redecoded.severity, "Info");
  assert.equal(redecoded.msg, "shutting down forY2K");
});

// payload は JSON object でなければならない（[MOQLOG] §4）。
test("LogEntry: JSON object でないと throw", () => {
  assert.throws(() => decodeLogEntry(new TextEncoder().encode("[1,2,3]")), /must be a JSON object/);
  assert.throws(() => decodeLogEntry(new TextEncoder().encode('"str"')), /must be a JSON object/);
});

test("LogEntry: 不正な JSON は throw", () => {
  assert.throws(
    () => decodeLogEntry(new TextEncoder().encode("{not json")),
    /invalid moqlog payload JSON/,
  );
});

// fatal:true の TextDecoder により、不正 UTF-8 バイトは ProtocolViolationError 経路で拒否する。
test("LogEntry: 不正 UTF-8 バイトは throw", () => {
  // JSON 文字列内に不正 UTF-8 バイト (0xff) を含む payload（{"msg":"<0xff>"}）
  const bytes = new Uint8Array([0x7b, 0x22, 0x6d, 0x73, 0x67, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]);
  assert.throws(() => decodeLogEntry(bytes), /invalid moqlog payload JSON/);
});

// severity 文字列 ↔ 優先度（0-7）の対応（msf-01 §9.2 / [RFC5424]）。
test("LOG_SEVERITY_LEVELS: syslog severity の対応", () => {
  assert.equal(LOG_SEVERITY_LEVELS.Emergency, 0);
  assert.equal(LOG_SEVERITY_LEVELS.Alert, 1);
  assert.equal(LOG_SEVERITY_LEVELS.Critical, 2);
  assert.equal(LOG_SEVERITY_LEVELS.Error, 3);
  assert.equal(LOG_SEVERITY_LEVELS.Warning, 4);
  assert.equal(LOG_SEVERITY_LEVELS.Notice, 5);
  assert.equal(LOG_SEVERITY_LEVELS.Informational, 6);
  assert.equal(LOG_SEVERITY_LEVELS.Debug, 7);
});

// msf-01 §9.3: Group ID は Unix epoch マイクロ秒を 62-bit に truncate。
test("logGroupId: Unix epoch マイクロ秒を 62-bit に truncate する", () => {
  // 62-bit 以内の値はそのまま
  assert.equal(logGroupId(1740807280000000n), 1740807280000000n);
  // 62-bit を超える値は下位 62-bit に truncate される
  const over = (1n << 62n) + 5n;
  assert.equal(logGroupId(over), 5n);
  // 境界値（62-bit 最大）はそのまま
  assert.equal(logGroupId((1n << 62n) - 1n), (1n << 62n) - 1n);
});

test("logGroupId: 負の timestamp は throw", () => {
  assert.throws(() => logGroupId(-1n), /non-negative/);
});

// msf-01 §9.3: Object ID は通常 0、同一マイクロ秒内のみ連番。
test("logObjectId: 同一マイクロ秒内の連番を返す", () => {
  assert.equal(logObjectId(0), 0n);
  assert.equal(logObjectId(1), 1n);
  assert.equal(logObjectId(7), 7n);
});

test("logObjectId: 負数・非整数は throw", () => {
  assert.throws(() => logObjectId(-1), /non-negative integer/);
  assert.throws(() => logObjectId(1.5), /non-negative integer/);
});

// [MOQLOG] §3 / msf-01 §9.2（暫定）: Track Namespace は 2 タプル。
test("logTrackNamespace: prefix と resourceID の 2 タプル", () => {
  assert.deepEqual(logTrackNamespace("res-1"), [MOQLOG_NAMESPACE_PREFIX, "res-1"]);
  assert.equal(MOQLOG_NAMESPACE_PREFIX, "moq://moq-syslog.arpa/logs-v1/");
});

// [MOQLOG] §3 / msf-01 §9.2（暫定）: Track Name は priority level の 1 バイト。
test("logTrackName: priority level の 1 バイトを返す", () => {
  assert.deepEqual(Array.from(logTrackName(0)), [0]);
  assert.deepEqual(Array.from(logTrackName(6)), [6]);
  assert.deepEqual(Array.from(logTrackName(7)), [7]);
});

test("logTrackName: 0-7 の範囲外・非整数は throw", () => {
  assert.throws(() => logTrackName(-1), /0-7/);
  assert.throws(() => logTrackName(8), /0-7/);
  assert.throws(() => logTrackName(1.5), /0-7/);
  assert.throws(() => logTrackName(Number.NaN), /0-7/);
});
