/**
 * MOQ Log (moqlog) の PBT テスト
 * draft-jennings-moq-log-04 ([MOQLOG]) / draft-ietf-moq-msf-01 §9 (Log track)
 */

import { test, assert } from "vite-plus/test";
import * as fc from "fast-check";
import { decodeLogRecord, encodeLogRecord, logTrackName, type LogRecord } from "./moqlog";

// ASCII フィールド用の printable ASCII 文字列。
const asciiArb = fc.string({ unit: "grapheme-ascii", maxLength: 16 });
// Message / Attribute 用の UTF-8 文字列。grapheme は孤立サロゲートを含まない。
const utf8Arb = fc.string({ unit: "grapheme", maxLength: 32 });

const logRecordArb: fc.Arbitrary<LogRecord> = fc.record({
  timestampOffset: fc.bigInt({ min: 0n, max: 999999999n }),
  facility: fc.integer({ min: 0, max: 23 }),
  hostname: asciiArb,
  appName: asciiArb,
  procId: asciiArb,
  msgId: asciiArb,
  message: utf8Arb,
  attributes: fc.array(fc.record({ key: utf8Arb, value: utf8Arb }), { maxLength: 4 }),
});

// [MOQLOG] §5.3: 型適合の Log Record は encode / decode の round-trip で内容が保持される。
test("LogRecord round-trip: 内容が保持される", () => {
  fc.assert(
    fc.property(logRecordArb, (record) => {
      assert.deepEqual(decodeLogRecord(encodeLogRecord(record)), record);
    }),
  );
});

// moq-log-04 §5.1: Track Name は log priority level の ASCII 数字 1 バイト
// （0=Emergency - 7=Debug）。
test("logTrackName: 0-7 の任意の level で ASCII 数字 1 バイトを返す", () => {
  fc.assert(
    fc.property(fc.integer({ min: 0, max: 7 }), (level) => {
      const name = logTrackName(level);
      assert.equal(name.length, 1);
      assert.equal(name[0], new TextEncoder().encode(String(level))[0]);
    }),
  );
});
