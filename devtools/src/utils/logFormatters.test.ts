import { test, assert } from "vite-plus/test";
import {
  formatAbsoluteTime,
  formatBitrate,
  formatBytes,
  formatDeltaTime,
  formatElapsedTime,
  formatHexDump,
  formatMessageData,
  formatTrackNameSuffix,
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
  // 分割代入で各行を取り出す (noUncheckedIndexedAccess で index access は
  // 型上 undefined を含むため、分割代入で回避する)
  const [firstLine, secondLine] = lines;
  if (firstLine === undefined || secondLine === undefined) {
    // 上の lines.length === 2 により到達しない (型を絞るためのガード)
    throw new Error("formatHexDump must return 2 lines for 17 bytes");
  }
  assert.ok(firstLine.startsWith("0000"));
  assert.ok(secondLine.startsWith("0010"));
});

test("formatHexDump generates 3 lines for 33 bytes (verify loop steady state)", () => {
  const data = new Uint8Array(33);
  for (let i = 0; i < 33; i++) data[i] = 0x42;
  const lines = formatHexDump(data).split("\n");
  assert.equal(lines.length, 3);
  const [firstLine, secondLine, thirdLine] = lines;
  if (firstLine === undefined || secondLine === undefined || thirdLine === undefined) {
    // 上の lines.length === 3 により到達しない (型を絞るためのガード)
    throw new Error("formatHexDump must return 3 lines for 33 bytes");
  }
  assert.ok(firstLine.startsWith("0000"));
  assert.ok(secondLine.startsWith("0010"));
  assert.ok(thirdLine.startsWith("0020"));
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

// isParameter は「大文字」と「underscore を含む」の AND 判定のため、underscore を含まない
// 大文字キーは MOQT Parameter ではなく通常フィールドとして表示される。
test("formatMessageData は underscore なしの大文字キーを Parameters ではなくフィールドに表示する", () => {
  const result = formatMessageData({ FOO: 1, SOME_PARAM: 2 });
  // SOME_PARAM だけが Parameters セクションに入る
  assert.ok(result.includes("Parameters:"));
  assert.ok(result.includes("SOME_PARAM: 2"));
  // FOO はフィールドとして Parameters セクションより前に出る
  assert.ok(result.includes("FOO: 1"));
  assert.ok(result.indexOf("FOO: 1") < result.indexOf("Parameters:"));
});

// trackNamespace + trackName は仕様の Full Track Name 形式 (draft-ietf-moq-transport-22
// §8.8) の 1 行にまとめ、生の配列とトラック名を別々に出さない。
test("formatMessageData は trackNamespace と trackName を Full Track Name 1 行にまとめる", () => {
  const result = formatMessageData({ trackNamespace: ["room", "123"], trackName: "video" });
  assert.ok(result.includes("Full Track Name: room-123--video"));
  // 生のフィールドの行が残っていない ("Full Track Name" の部分一致と区別する)
  assert.ok(!result.includes("\n  Track Namespace:"));
  assert.ok(!result.includes("\n  Track Name:"));
});

// フィールドの並びが trackName → trackNamespace でも同じ結果になる
// (decoded のプロパティ順に依存しない)。
test("formatMessageData は trackName が先でも Full Track Name 1 行にまとめる", () => {
  const result = formatMessageData({ trackName: "video", trackNamespace: ["room"] });
  assert.ok(result.includes("Full Track Name: room--video"));
  assert.ok(!result.includes("\n  Track Namespace:"));
  assert.ok(!result.includes("\n  Track Name:"));
});

// エスケープ規則は Full Track Name の組み立てと共通。
test("formatMessageData は Full Track Name の区切り文字を §8.8 の規則でエスケープする", () => {
  const result = formatMessageData({ trackNamespace: ["a"], trackName: "b/c" });
  assert.ok(result.includes("Full Track Name: a--b.2fc"));
});

// trackName を持たないメッセージ (PUBLISH_NAMESPACE など) は namespace 単体を
// §8.8 の namespace 表記で出す。
test("formatMessageData は trackNamespace 単体を §8.8 の表記にする", () => {
  const result = formatMessageData({ trackNamespace: ["room", "123"] });
  assert.ok(result.includes("Track Namespace: room-123"));
  const prefix = formatMessageData({ trackNamespacePrefix: ["live", "sports"] });
  assert.ok(prefix.includes("Track Namespace Prefix: live-sports"));
});

// decoded には string[] 以外の値 (バイト列など) も来る。§8.8 の表記にできない値は
// 生の値のまま出し、ログの表示を壊さない。
test("formatMessageData は表記できない trackNamespace を生の値のまま出す", () => {
  const bytes = [new Uint8Array([0x72]), new Uint8Array([0x31])];
  const result = formatMessageData({ trackNamespace: bytes, trackName: "video" });
  assert.ok(result.includes("Track Namespace"));
  assert.ok(result.includes("Track Name: video"));
  // 空の Track Namespace Field (§8.7 違反) でも throw しない
  const emptyField = formatMessageData({
    trackNamespace: ["room", "", "123"],
    trackName: "video",
  });
  assert.ok(emptyField.includes("Track Namespace"));
});

// 空の Track Namespace (0 フィールド) は §8.7 が許すが、§8.8 の表記は空文字列に
// なるため、生の値 ("[]") のまま出す。
test("formatMessageData は空の trackNamespace を [] のまま出す", () => {
  const result = formatMessageData({ trackNamespace: [] });
  assert.ok(result.includes("Track Namespace: []"));
});

// ログ行の末尾に付ける Full Track Name。decoded が track の情報を持たないときは
// 何も付けない (行はメッセージ種別のまま)。
test("formatTrackNameSuffix: Full Track Name を先頭の空白付きで返す", () => {
  assert.equal(
    formatTrackNameSuffix({ trackNamespace: ["room", "123"], trackName: "video" }),
    " room-123--video",
  );
  assert.equal(formatTrackNameSuffix({}), "");
  assert.equal(formatTrackNameSuffix(undefined), "");
  // 表記にできない値 (バイト列) では何も付けない
  assert.equal(
    formatTrackNameSuffix({ trackNamespace: [new Uint8Array([0x72])], trackName: "video" }),
    "",
  );
});

// formatBytes は devtools 内で唯一の実装であり、各パネルが同じ丸めを使う。
// 単位は 1024 進の 2 進接頭辞 (KiB / MiB) にして、1000 進の KB / MB と区別する
test("formatBytes switches unit at 1024 and 1024*1024", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(1023), "1023 B");
  assert.equal(formatBytes(1024), "1.0 KiB");
  assert.equal(formatBytes(1536), "1.5 KiB");
  assert.equal(formatBytes(1024 * 1024 - 1), "1024.0 KiB");
  assert.equal(formatBytes(1024 * 1024), "1.00 MiB");
  assert.equal(formatBytes(1024 * 1024 * 2.5), "2.50 MiB");
});

// ビットレートは 1000 進 (通信速度の慣例)。
test("formatBitrate switches unit at 1000 and 1000*1000", () => {
  assert.equal(formatBitrate(0), "0 bps");
  assert.equal(formatBitrate(999), "999 bps");
  assert.equal(formatBitrate(1000), "1 kbps");
  assert.equal(formatBitrate(1500), "2 kbps");
  assert.equal(formatBitrate(1000 * 1000 - 1), "1000 kbps");
  assert.equal(formatBitrate(1000 * 1000), "1.0 Mbps");
  assert.equal(formatBitrate(2500 * 1000), "2.5 Mbps");
});
