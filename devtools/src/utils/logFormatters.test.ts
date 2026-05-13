import { test, assert } from "vite-plus/test";
import {
  formatAbsoluteTime,
  formatDeltaTime,
  formatElapsedTime,
  formatHexDump,
  formatMessageData,
  isParameter,
} from "./logFormatters";

// formatAbsoluteTime はタイムゾーン依存なので、Date 経由で期待値を組み立てて比較する。
test("formatAbsoluteTime returns HH:MM:SS.mmm format", () => {
  const timestamp = 1700000000000;
  const date = new Date(timestamp);
  const expected = `${date.getHours().toString().padStart(2, "0")}:${date
    .getMinutes()
    .toString()
    .padStart(2, "0")}:${date.getSeconds().toString().padStart(2, "0")}.${date
    .getMilliseconds()
    .toString()
    .padStart(3, "0")}`;
  assert.equal(formatAbsoluteTime(timestamp), expected);
});

test("formatAbsoluteTime zero-pads milliseconds (1ms case)", () => {
  // 任意の日時の 1 ミリ秒部分が ".001" になる。
  const date = new Date(2024, 0, 1, 12, 34, 56, 1);
  assert.equal(formatAbsoluteTime(date.getTime()), "12:34:56.001");
});

test("formatElapsedTime returns +0.000 when timestamp equals firstTimestamp", () => {
  assert.equal(formatElapsedTime(1000, 1000), "+0.000");
});

test("formatElapsedTime returns +1.001 for 1001ms gap", () => {
  assert.equal(formatElapsedTime(2001, 1000), "+1.001");
});

test("formatElapsedTime returns +59.999 for 59999ms gap", () => {
  assert.equal(formatElapsedTime(60999, 1000), "+59.999");
});

test("formatDeltaTime returns empty string when previousTimestamp is null", () => {
  assert.equal(formatDeltaTime(1000, null), "");
});

test("formatDeltaTime returns (+0ms) for equal timestamps", () => {
  assert.equal(formatDeltaTime(1000, 1000), "(+0ms)");
});

test("formatDeltaTime returns (+12345ms) for 12345ms delta", () => {
  assert.equal(formatDeltaTime(13345, 1000), "(+12345ms)");
});

test("formatHexDump returns empty string for empty Uint8Array", () => {
  assert.equal(formatHexDump(new Uint8Array()), "");
});

test("formatHexDump formats a single byte with offset / padding / ASCII", () => {
  const result = formatHexDump(new Uint8Array([0x41]));
  // 0000 (4桁オフセット) + 16 個分の hex (1 個 = "41"、残り = "  ") + " | A|" の ASCII
  assert.equal(result, "0000  41                                                |A|");
});

test("formatHexDump wraps at 16-byte boundary", () => {
  const data = new Uint8Array(17);
  for (let i = 0; i < 17; i++) data[i] = 0x41;
  const lines = formatHexDump(data).split("\n");
  assert.equal(lines.length, 2);
  assert.ok(lines[0].startsWith("0000"));
  assert.ok(lines[1].startsWith("0010"));
});

test("formatHexDump generates 3 lines for 33 bytes (verify loop steady state)", () => {
  const data = new Uint8Array(33);
  for (let i = 0; i < 33; i++) data[i] = 0x42;
  const lines = formatHexDump(data).split("\n");
  assert.equal(lines.length, 3);
  assert.ok(lines[0].startsWith("0000"));
  assert.ok(lines[1].startsWith("0010"));
  assert.ok(lines[2].startsWith("0020"));
});

test("formatHexDump replaces non-printable bytes with dot in ASCII column", () => {
  const data = new Uint8Array([0x00, 0x1f, 0x7f, 0x80, 0xff]);
  const result = formatHexDump(data);
  // ASCII 部の各バイトが "." になっていることのみ確認。
  assert.ok(result.endsWith("|.....|"));
});

test("formatMessageData returns empty string for null/undefined", () => {
  assert.equal(formatMessageData(null), "");
  assert.equal(formatMessageData(undefined), "");
});

test("formatMessageData stringifies primitives", () => {
  assert.equal(formatMessageData("abc"), "abc");
  assert.equal(formatMessageData(42), "42");
  assert.equal(formatMessageData(true), "true");
  assert.equal(formatMessageData(42n), "42");
});

test("formatMessageData renders empty array as []", () => {
  assert.equal(formatMessageData([]), "[]");
});

test("formatMessageData renders scalar array as comma-separated", () => {
  assert.equal(formatMessageData([1, 2, 3]), "[1, 2, 3]");
});

test("formatMessageData JSON-stringifies array with object elements", () => {
  const result = formatMessageData([{ a: 1 }]);
  assert.equal(result, JSON.stringify([{ a: 1 }], null, 2));
});

test("formatMessageData returns empty string for empty object", () => {
  assert.equal(formatMessageData({}), "");
});

test("formatMessageData renames known field via RFC_FIELD_NAMES", () => {
  const result = formatMessageData({ requestId: 1 });
  assert.ok(result.includes("Request ID: 1"));
});

test("formatMessageData groups ALL_CAPS keys under Parameters section", () => {
  const result = formatMessageData({ SOME_PARAM: 1 });
  assert.ok(result.includes("Parameters:"));
  assert.ok(result.includes("SOME_PARAM: 1"));
});

test("formatMessageData indents nested objects", () => {
  const result = formatMessageData({ outer: { inner: 1 } });
  assert.ok(result.includes("outer: {"));
  assert.ok(result.includes("inner: 1"));
});

test("formatMessageData skips undefined values", () => {
  const result = formatMessageData({ a: 1, b: undefined });
  assert.ok(result.includes("a: 1"));
  assert.ok(!result.includes("b:"));
});

test("isParameter matches uppercase keys with underscore", () => {
  assert.equal(isParameter("FOO_BAR"), true);
  assert.equal(isParameter("FOO"), false);
  assert.equal(isParameter("foo_bar"), false);
  assert.equal(isParameter("Foo_Bar"), false);
});
