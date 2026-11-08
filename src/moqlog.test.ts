/**
 * MOQ Log (moqlog) の単体テスト
 * draft-jennings-moq-log-03 ([MOQLOG]) / draft-ietf-moq-msf-01 §9 (Log track)
 *
 * 型適合の LogEntry に対する round-trip は moqlog.prop.ts の PBT で検証する。
 * 本ファイルは §7 ベクタ・空オブジェクト・エラーパス・各 helper の固有挙動を扱う。
 */

import { test, assert } from "vite-plus/test";
import { ProtocolViolationError } from "./error";

import { encodeJson } from "./testSupport/helpers";
import { formatFullTrackName, formatTrackNamespace, parseTrackNamespace } from "./fullTrackName";
import { resolveCatalogVariables, type Catalog } from "./msf";
import {
  MOQLOG_NAMESPACE_PREFIX,
  MOQLOG_NAMESPACE_TEMPLATE,
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

// [MOQLOG] §7 の例は severity に短縮形 "Info" を使うが、§4 本文の正規形は "Informational"。
// decode は値列挙を厳格化しないため "Info" はそのまま通る (正規形への変換は行わない)。
// severity 文字列の任意値の round-trip は moqlog.prop.ts の PBT が検証する。
test("severity 短縮形: 受理しても正規形へ変換されない", () => {
  const decoded = decodeLogEntry(encodeJson({ severity: "Info" }));
  assert.equal(decoded.severity, "Info");
});

// msf-01 §9.3: Group ID は Unix epoch マイクロ秒を 62-bit に truncate。
// 62-bit の境界値は PBT (moqlog.prop.ts) が確率的にしか踏まないため、ここで固定する。
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

// moq-log-04 §5.1: Track Namespace は ("logs.moq.arpa", "v1", resourceID) の 3 field。
test("logTrackNamespace: 3 field の Track Namespace を返す", () => {
  assert.deepEqual(MOQLOG_NAMESPACE_PREFIX, ["logs.moq.arpa", "v1"]);
  const namespace = logTrackNamespace("8f2c4a1b0e9d7c63");
  assert.deepEqual(namespace, ["logs.moq.arpa", "v1", "8f2c4a1b0e9d7c63"]);
  assert.equal(formatTrackNamespace(namespace), "logs.2emoq.2earpa-v1-8f2c4a1b0e9d7c63");
  assert.deepEqual(parseTrackNamespace(formatTrackNamespace(namespace)), namespace);
  assert.equal(formatFullTrackName(namespace, "6"), "logs.2emoq.2earpa-v1-8f2c4a1b0e9d7c63--6");
});

// moq-log-04 §6: publishTracks の namespace は §8.8 形式で %resourceId% を保持する。
test("MOQLOG_NAMESPACE_TEMPLATE: %resourceId% を保持し 3 field に展開できる", () => {
  assert.equal(MOQLOG_NAMESPACE_TEMPLATE, "logs.2emoq.2earpa-v1-%resourceId%");
  const catalog: Catalog = {
    version: "draft-01",
    tracks: [],
    publishTracks: [
      {
        name: "6",
        namespace: MOQLOG_NAMESPACE_TEMPLATE,
        packaging: "moqlog",
        role: "log",
        isLive: true,
      },
    ],
  };
  const resolved = resolveCatalogVariables(catalog, { resourceId: "8f2c4a1b0e9d7c63" });
  const namespace = resolved.publishTracks?.[0]?.namespace;
  assert.equal(namespace, "logs.2emoq.2earpa-v1-8f2c4a1b0e9d7c63");
  assert.deepEqual(parseTrackNamespace(namespace ?? ""), logTrackNamespace("8f2c4a1b0e9d7c63"));

  // 未置換の template は §8.8 の literal でも escape でもない `%` を含むため parse できない。
  assert.throws(() => parseTrackNamespace(MOQLOG_NAMESPACE_TEMPLATE), /%/);

  // placeholder を含む 3 field tuple を直接 format すると `%` が `.25` になり、
  // resolveCatalogVariables の `%name%` として置換されない。
  const escaped = formatTrackNamespace(["logs.moq.arpa", "v1", "%resourceId%"]);
  assert.equal(escaped, "logs.2emoq.2earpa-v1-.25resourceId.25");
  const escapedCatalog: Catalog = {
    version: "draft-01",
    tracks: [],
    publishTracks: [
      {
        name: "6",
        namespace: escaped,
        packaging: "moqlog",
        role: "log",
        isLive: true,
      },
    ],
  };
  assert.equal(
    resolveCatalogVariables(escapedCatalog, { resourceId: "8f2c4a1b0e9d7c63" }).publishTracks?.[0]
      ?.namespace,
    escaped,
  );
});

// moq-log-04 §5.1: Track Name は priority level の ASCII 数字 1 バイト。
// 0-7 の全値は moqlog.prop.ts の PBT が網羅するため、ここでは境界値とエラーパスを固定する。
test("logTrackName: 境界値は ASCII 数字 1 バイト、範囲外・非整数は throw", () => {
  assert.deepEqual(logTrackName(0), new TextEncoder().encode("0"));
  assert.deepEqual(logTrackName(7), new TextEncoder().encode("7"));
  assert.throws(() => logTrackName(-1), /0-7/);
  assert.throws(() => logTrackName(8), /0-7/);
  assert.throws(() => logTrackName(1.5), /0-7/);
  assert.throws(() => logTrackName(Number.NaN), /0-7/);
});

// 既知フィールドの型誤りはデコード時に検出する。値列挙の厳格化はしない。
test("LogEntry: 既知フィールドの型誤りは throw", () => {
  assert.throws(
    () => decodeLogEntry(encodeJson({ severity: 3 })),
    ProtocolViolationError,
    /must be a string/,
  );
  assert.throws(
    () => decodeLogEntry(encodeJson({ timestamp: "3155587200" })),
    ProtocolViolationError,
    /must be a finite number/,
  );
  assert.throws(
    () => decodeLogEntry(encodeJson({ pri: "1" })),
    ProtocolViolationError,
    /must be a finite number/,
  );
  assert.throws(
    () => decodeLogEntry(encodeJson({ hostname: 42 })),
    ProtocolViolationError,
    /must be a string/,
  );
  assert.throws(
    () => decodeLogEntry(encodeJson({ msg: 123 })),
    ProtocolViolationError,
    /must be a string/,
  );
  assert.throws(
    () => decodeLogEntry(encodeJson({ severity: null })),
    ProtocolViolationError,
    /must be a string/,
  );
  // 未知フィールドの任意型は受理のままであること
  assert.deepEqual(decodeLogEntry(encodeJson({ traceId: 42 })), { traceId: 42 });
});

// [MOQLOG] §4: pri は RFC5424 の 0-23。本実装は LOG_ENTRY_FIELD_TYPES で finite number の
// みを検査し、値域は送信側の規約として検査しない。したがって値域内・値域外のいずれも
// round-trip でそのまま保持される。
test("LogEntry: pri は値域 (0-23) を検査せず round-trip で保持される", () => {
  for (const pri of [0, 1, 23, -1, 24, 1.5]) {
    assert.equal(decodeLogEntry(encodeLogEntry({ pri })).pri, pri);
  }
});

// [MOQLOG] §4 の "default is 1 if not present" は受信側の解釈であり、本実装は
// 欠落を欠落のまま保持する (既定値の適用は呼び出し側の責務)。
test("LogEntry: pri が欠落していても既定値 1 を補わない", () => {
  const decoded = decodeLogEntry(encodeLogEntry({ msg: "hello" }));
  assert.isUndefined(decoded.pri);
});

// 非有限数は null 化して送出されるため、エンコード時に失敗させる。
test("LogEntry: 非有限数のエンコードは throw", () => {
  assert.throws(() => encodeLogEntry({ timestamp: Number.NaN }), /non-finite/);
  assert.throws(() => encodeLogEntry({ pri: Number.POSITIVE_INFINITY }), /non-finite/);
  assert.throws(() => encodeLogEntry({ timestamp: Number.NEGATIVE_INFINITY }), /non-finite/);
});

test("logTrackNamespace: 16 桁小文字 hexadecimal 以外の resourceId は throw", () => {
  for (const resourceId of [
    "",
    "res-1",
    "8F2C4A1B0E9D7C63",
    "8f2c4a1b0e9d7c6",
    "8f2c4a1b0e9d7c630",
    "8f2c4a1b0e9d7c6g",
    "8f2c4a1b0e9d7c63\n",
    " 8f2c4a1b0e9d7c63",
    "8f2c4a1b0e9d7c63 ",
  ]) {
    assert.throws(() => logTrackNamespace(resourceId), /resourceId/);
  }
  assert.throws(() => logTrackNamespace(123 as unknown as string), /resourceId/);
});
