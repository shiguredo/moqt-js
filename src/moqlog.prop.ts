/**
 * MOQ Log (moqlog) の PBT テスト
 * draft-jennings-moq-log-03 ([MOQLOG]) / draft-ietf-moq-msf-01 §9 (Log track)
 */

import { test, assert } from "vite-plus/test";
import * as fc from "fast-check";
import {
  encodeLogEntry,
  decodeLogEntry,
  logGroupId,
  logTrackName,
  LOG_ENTRY_FIELD_TYPES,
  type LogEntry,
} from "./moqlog";

// JSON round-trip で壊れる値（undefined / NaN / Infinity）を除外した JSON 安全な値の arbitrary。
const jsonValueArb: fc.Arbitrary<unknown> = fc.letrec((tie) => ({
  value: fc.oneof(
    fc.string(),
    fc.integer(),
    fc.boolean(),
    fc.constant(null),
    fc.array(tie("value"), { maxLength: 3 }),
    fc.dictionary(fc.string({ minLength: 1, maxLength: 8 }), tie("value"), { maxKeys: 3 }),
  ),
})).value;

// 既知フィールドは型適合のみ生成する (値列挙の厳格化はしない)。
// 既知フィールド追加時は LOG_ENTRY_FIELD_TYPES と同期すること。
// 未知フィールドは既知名と重ならない任意の JSON 安全値を生成する。
const KNOWN_LOG_FIELD_NAMES: ReadonlySet<string> = new Set(Object.keys(LOG_ENTRY_FIELD_TYPES));

// LogEntry は全フィールド optional + 未知フィールド許容のため、
// 型適合の既知フィールドと既知名を避けた未知フィールドで生成する。
const logEntryArb: fc.Arbitrary<LogEntry> = fc
  .tuple(
    fc.record({
      severity: fc.option(fc.string(), { nil: undefined }),
      timestamp: fc.option(fc.integer(), { nil: undefined }),
      pri: fc.option(fc.integer(), { nil: undefined }),
      hostname: fc.option(fc.string(), { nil: undefined }),
      appname: fc.option(fc.string(), { nil: undefined }),
      procid: fc.option(fc.string(), { nil: undefined }),
      msgid: fc.option(fc.string(), { nil: undefined }),
      msg: fc.option(fc.string(), { nil: undefined }),
    }),
    fc.dictionary(
      // `__proto__` を除外する。代入結合で prototype 置換になり
      // round-trip が flaky に壊れるため
      fc.string({ minLength: 1, maxLength: 16 }).filter((key) => key !== "__proto__"),
      jsonValueArb,
      { maxKeys: 8 },
    ),
  )
  .map(([known, extra]) => {
    const entry: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(known)) {
      if (value !== undefined) {
        entry[key] = value;
      }
    }
    for (const [key, value] of Object.entries(extra)) {
      if (!KNOWN_LOG_FIELD_NAMES.has(key)) {
        entry[key] = value;
      }
    }
    return entry as LogEntry;
  });

// [MOQLOG] §4: payload は型適合の LogEntry。encode / decode の round-trip で内容が保持される。
// 既知フィールドの型誤りは別途単体テストで拒否を検証する。
test("LogEntry round-trip: 型適合の LogEntry で内容が保持される", () => {
  fc.assert(
    fc.property(logEntryArb, (entry) => {
      const decoded = decodeLogEntry(encodeLogEntry(entry));
      assert.deepEqual(decoded, entry);
    }),
  );
});

// msf-01 §9.3: Group ID は 62-bit 未満。非負 timestamp の truncate 結果は常に 0 以上 2^62 未満。
test("logGroupId: 非負 timestamp を 62-bit に truncate する", () => {
  fc.assert(
    fc.property(fc.bigInt({ min: 0n, max: (1n << 64n) - 1n }), (timestampMicros) => {
      const groupId = logGroupId(timestampMicros);
      // truncate 意味論: 下位 62-bit と一致する
      assert.equal(groupId, timestampMicros & ((1n << 62n) - 1n));
      assert.isTrue(groupId >= 0n);
      assert.isTrue(groupId < 1n << 62n);
    }),
  );
});

// [MOQLOG] §3: Track Name は log priority level の 1 バイト（0=Emergency - 7=Debug）。
test("logTrackName: 0-7 の任意の level で 1 バイトを返す", () => {
  fc.assert(
    fc.property(fc.integer({ min: 0, max: 7 }), (level) => {
      const name = logTrackName(level);
      assert.equal(name.length, 1);
      assert.equal(name[0], level);
    }),
  );
});
