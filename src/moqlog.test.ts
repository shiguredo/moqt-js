/**
 * MOQ Log (moqlog) の単体テスト
 * draft-jennings-moq-log-04 ([MOQLOG]) / draft-ietf-moq-msf-01 §9 (Log track)
 *
 * Log Record の round-trip は moqlog.prop.ts の PBT が検証する。
 * 本ファイルは §5.3 の固定ワイヤ・境界値・エラーパス・各 helper の固有挙動を扱う。
 */

import { test, assert } from "vite-plus/test";
import { IncompleteDataError, ProtocolViolationError, SessionErrorCode } from "./error";

import { formatFullTrackName, formatTrackNamespace, parseTrackNamespace } from "./fullTrackName";
import { ObjectStatus } from "./message/types";
import { PublisherImpl, type SendObjectParams } from "./publisher";
import { resolveCatalogVariables, type Catalog } from "./msf";
import {
  LOG_SEVERITY_LEVELS,
  MOQLOG_NAMESPACE_PREFIX,
  MOQLOG_NAMESPACE_TEMPLATE,
  decodeLogRecord,
  encodeLogRecord,
  logGroupId,
  logObjectId,
  logPriorGroupIdGap,
  logTrackNamespace,
  logTrackName,
  type LogRecord,
} from "./moqlog";
import { MAX_VARINT } from "./varint";

// decodeLogRecord の構造不正は Object Payload のデコード失敗として
// MALFORMED_OBJECT に統一する。メッセージも合わせて確認する。
function assertMalformedObject(fn: () => unknown, message: RegExp): void {
  let error: unknown;
  try {
    fn();
  } catch (caught) {
    error = caught;
  }
  assert.isTrue(error instanceof ProtocolViolationError);
  if (error instanceof ProtocolViolationError) {
    assert.equal(error.code, SessionErrorCode.MALFORMED_OBJECT);
    assert.match(error.message, message);
  }
}

const EMPTY_RECORD: LogRecord = {
  timestampOffset: 0n,
  facility: 0,
  hostname: "",
  appName: "",
  procId: "",
  msgId: "",
  message: "",
  attributes: [],
};

// [MOQLOG] §5.3: 全フィールドが空の Log Record は 8 個の vi64 0 になる。
test("LogRecord: 空の Log Record の固定ワイヤ", () => {
  assert.deepEqual(encodeLogRecord(EMPTY_RECORD), new Uint8Array(8));
  assert.deepEqual(decodeLogRecord(new Uint8Array(8)), EMPTY_RECORD);
});

// [MOQLOG] §5.3: Timestamp Offset / Facility / 各長さ / 各文字列 / Attributes の順序。
test("LogRecord: 各フィールドの固定ワイヤ", () => {
  const record: LogRecord = {
    timestampOffset: 250000000n,
    facility: 1,
    hostname: "h",
    appName: "a",
    procId: "p",
    msgId: "m",
    message: "x",
    attributes: [{ key: "k", value: "v" }],
  };
  // 内訳: timestampOffset 250000000 (4 bytes) / facility 1 (1) /
  // hostname "h" (2) / appName "a" (2) / procId "p" (2) / msgId "m" (2) /
  // message "x" (2) / attributes 1 (1) / key "k" (2) / value "v" (2)。
  const expected = new Uint8Array([
    0xee, 0xe6, 0xb2, 0x80, 0x01, 0x01, 0x68, 0x01, 0x61, 0x01, 0x70, 0x01, 0x6d, 0x01, 0x78, 0x01,
    0x01, 0x6b, 0x01, 0x76,
  ]);
  assert.deepEqual(encodeLogRecord(record), expected);
  assert.deepEqual(decodeLogRecord(expected), record);
});

// [MOQLOG] §5.8: Group 946684799 の offset 900000000 と Group 946684805 の offset 120000 を
// round-trip する。
test("LogRecord: §5.8 の offset 900000000 と 120000 を round-trip する", () => {
  for (const [timestampOffset, message] of [
    [900000000n, "shutting down for Y2K"],
    [120000n, "back online"],
  ] as const) {
    const record: LogRecord = {
      ...EMPTY_RECORD,
      facility: 1,
      appName: "y2kd",
      message,
      timestampOffset,
    };
    assert.deepEqual(decodeLogRecord(encodeLogRecord(record)), record);
  }
});

// [MOQLOG] §5.3: Message と Attribute は UTF-8。多バイト文字を保持する。
test("LogRecord: UTF-8 の Message と Attribute を round-trip する", () => {
  const record: LogRecord = {
    ...EMPTY_RECORD,
    message: "こんにちは\u{1F600}",
    attributes: [
      { key: "鍵", value: "値" },
      { key: "鍵", value: "別の値" },
    ],
  };
  assert.deepEqual(decodeLogRecord(encodeLogRecord(record)), record);
});

// [MOQLOG] §5.3: UTF-8 の先頭 BOM (U+FEFF) はフィールドの一部であり、decode で消さない。
test("LogRecord: 先頭 BOM を保持する", () => {
  const record: LogRecord = {
    ...EMPTY_RECORD,
    message: "\uFEFFmessage",
    attributes: [{ key: "\uFEFFkey", value: "\uFEFFvalue" }],
  };
  assert.deepEqual(decodeLogRecord(encodeLogRecord(record)), record);
});

// TextEncoder は孤立サロゲートを U+FFFD に置換するため、round-trip を保つには拒否する。
test("LogRecord: 孤立サロゲートを拒否する", () => {
  assert.throws(
    () => encodeLogRecord({ ...EMPTY_RECORD, message: "\uD800" }),
    /unpaired surrogate/,
  );
  assert.throws(
    () => encodeLogRecord({ ...EMPTY_RECORD, attributes: [{ key: "a", value: "\uDC00" }] }),
    /unpaired surrogate/,
  );
});

// [MOQLOG] §5.3: Attributes は順序と重複キーを保持する。
test("LogRecord: Attributes の順序と重複キーを保持する", () => {
  const record: LogRecord = {
    ...EMPTY_RECORD,
    attributes: [
      { key: "a", value: "1" },
      { key: "a", value: "2" },
      { key: "b", value: "3" },
    ],
  };
  assert.deepEqual(decodeLogRecord(encodeLogRecord(record)).attributes, record.attributes);
});

// [MOQLOG] §5.3: Length / Number of Attributes は vi64。2 バイト表現も扱える。
test("LogRecord: 128 バイトの Message と 128 個の Attributes を扱える", () => {
  const message = "a".repeat(128);
  const attributes = Array.from({ length: 128 }, (_, index) => ({
    key: `k${index}`,
    value: `v${index}`,
  }));
  const record: LogRecord = { ...EMPTY_RECORD, message, attributes };
  const encoded = encodeLogRecord(record);
  // 6 バイト目から Message の vi64 Length (128 = 0x80 0x80)、
  // Message 128 バイトの後ろが Number of Attributes (128 = 0x80 0x80)。
  assert.deepEqual(encoded.subarray(6, 8), new Uint8Array([0x80, 0x80]));
  assert.deepEqual(encoded.subarray(136, 138), new Uint8Array([0x80, 0x80]));
  const decoded = decodeLogRecord(encoded);
  assert.equal(decoded.message, message);
  assert.deepEqual(decoded.attributes, attributes);
});

// [MOQLOG] §5.3: 定義済みフィールドの後のバイトは将来拡張として無視する。
test("LogRecord: 定義済みフィールド後の将来拡張バイトを無視する", () => {
  const encoded = encodeLogRecord(EMPTY_RECORD);
  const withExtension = new Uint8Array(encoded.length + 2);
  withExtension.set(encoded, 0);
  withExtension.set([0xff, 0x00], encoded.length);
  assert.deepEqual(decodeLogRecord(withExtension), EMPTY_RECORD);
});

// [MOQLOG] §5.3: Timestamp Offset は 10^9 未満、Facility は 0-23。
test("LogRecord: timestampOffset と facility の境界", () => {
  assert.deepEqual(
    decodeLogRecord(encodeLogRecord({ ...EMPTY_RECORD, timestampOffset: 999999999n }))
      .timestampOffset,
    999999999n,
  );
  assert.throws(
    () => encodeLogRecord({ ...EMPTY_RECORD, timestampOffset: 1000000000n }),
    /timestampOffset/,
  );
  // 10^9 の vi64 は 0xf0 0x3b 0x9a 0xca 0x00
  assertMalformedObject(
    () => decodeLogRecord(new Uint8Array([0xf0, 0x3b, 0x9a, 0xca, 0x00])),
    /timestampOffset/,
  );
  for (const facility of [0, 23]) {
    assert.equal(
      decodeLogRecord(encodeLogRecord({ ...EMPTY_RECORD, facility })).facility,
      facility,
    );
  }
  assert.throws(() => encodeLogRecord({ ...EMPTY_RECORD, facility: 24 }), /facility/);
  assertMalformedObject(() => decodeLogRecord(new Uint8Array([0x00, 0x18])), /facility/);
});

// JavaScript から number を渡した場合は、値域違反ではなく型違反として拒否する。
test("LogRecord: timestampOffset の型違反を拒否する", () => {
  assert.throws(
    () => encodeLogRecord({ ...EMPTY_RECORD, timestampOffset: 1 as unknown as bigint }),
    /must be a bigint/,
  );
  assert.throws(
    () => encodeLogRecord({ ...EMPTY_RECORD, timestampOffset: null as unknown as bigint }),
    /must be a bigint: null/,
  );
});

// [MOQLOG] §5.3: Hostname / App Name / Proc ID / Msg ID は ASCII。
test("LogRecord: 4 つの ASCII フィールドは 0x7f まで受理し 0x80 を拒否する", () => {
  for (const field of ["hostname", "appName", "procId", "msgId"] as const) {
    const record: LogRecord = { ...EMPTY_RECORD, [field]: "\u007F" };
    assert.deepEqual(decodeLogRecord(encodeLogRecord(record)), record);
    assert.throws(() => encodeLogRecord({ ...EMPTY_RECORD, [field]: "\u0080" }), /ASCII/);
  }
  // decode 側は hostname の 1 バイト 0x80 で代表する
  assertMalformedObject(
    () => decodeLogRecord(new Uint8Array([0x00, 0x00, 0x01, 0x80])),
    /non-ASCII/,
  );
});

// [MOQLOG] §5.3: Message は UTF-8。不正な UTF-8 は ProtocolViolationError にする。
test("LogRecord: Message の不正 UTF-8 を拒否する", () => {
  // timestamp 0 / facility 0 / hostname 0 / appName 0 / procId 0 / msgId 0 /
  // message length 1 / byte 0xff
  assertMalformedObject(
    () => decodeLogRecord(new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0xff])),
    /UTF-8/,
  );
});

// [MOQLOG] §5.3: vi64 の切り詰めは IncompleteDataError、宣言長の超過は ProtocolViolationError。
test("LogRecord: 切り詰めと長さ超過を拒否する", () => {
  assert.throws(() => decodeLogRecord(new Uint8Array(0)), IncompleteDataError);
  // timestamp 0 だけで facility が無い
  assert.throws(() => decodeLogRecord(new Uint8Array([0x00])), IncompleteDataError);
  // timestamp 0 / facility 0 / hostname length 5（残り 0 バイト）
  assertMalformedObject(() => decodeLogRecord(new Uint8Array([0x00, 0x00, 0x05])), /length/);
});

// JavaScript からは型と異なる値が渡り得るため、実行時にも型を検証する。
test("LogRecord: 文字列でないフィールドと attributes の配列違反を拒否する", () => {
  assert.throws(
    () => encodeLogRecord({ ...EMPTY_RECORD, hostname: 1 as unknown as string }),
    /must be a string/,
  );
  assert.throws(
    () => encodeLogRecord({ ...EMPTY_RECORD, attributes: null as unknown as [] }),
    /must be an array/,
  );
  assert.throws(() => encodeLogRecord(null as unknown as LogRecord), /must be an object: null/);
  assert.throws(
    () => encodeLogRecord({ ...EMPTY_RECORD, attributes: [null] as unknown as [] }),
    /must be an object/,
  );
  assert.throws(
    () => encodeLogRecord({ ...EMPTY_RECORD, facility: "1" as unknown as number }),
    /facility/,
  );
  assert.throws(
    () => encodeLogRecord({ ...EMPTY_RECORD, message: 1 as unknown as string }),
    /must be a string/,
  );
  assert.throws(
    () =>
      encodeLogRecord({
        ...EMPTY_RECORD,
        attributes: [{ key: 1, value: "v" }] as unknown as [],
      }),
    /must be a string/,
  );
});

// [MOQLOG] §5.1: severity の文字列は Track Name の決定に使える。
test("LOG_SEVERITY_LEVELS: 8 段階すべてのレベル名と優先度の対応", () => {
  const expected = {
    Emergency: 0,
    Alert: 1,
    Critical: 2,
    Error: 3,
    Warning: 4,
    Notice: 5,
    Informational: 6,
    Debug: 7,
  } as const;
  for (const [name, level] of Object.entries(expected)) {
    assert.equal(LOG_SEVERITY_LEVELS[name], level);
  }
});

// [MOQLOG] §5.2: Group ID は Unix epoch 秒。§5.8 の例を再現する。
test("logGroupId: マイクロ秒を秒へ切り捨てる", () => {
  assert.equal(logGroupId(946684799250000n), 946684799n);
  assert.equal(logGroupId(946684799900000n), 946684799n);
  assert.equal(logGroupId(946684805000120n), 946684805n);
  assert.equal(logGroupId(946684799000000n), 946684799n);
});

// §5.8 の 3 つの offset は、マイクロ秒 / 絶対ナノ秒のどちらの入力からも同じ値になる。
test("logGroupId: マイクロ秒と絶対ナノ秒の換算が一致する", () => {
  const cases = [
    [946684799250000n, 946684799n, 250000000n],
    [946684799900000n, 946684799n, 900000000n],
    [946684805000120n, 946684805n, 120000n],
  ] as const;
  for (const [micros, groupId, offset] of cases) {
    const nanos = micros * 1000n;
    assert.equal(logGroupId(micros), groupId);
    assert.equal(nanos / 1_000_000_000n, groupId);
    assert.equal((micros % 1_000_000n) * 1000n, offset);
    assert.equal(nanos % 1_000_000_000n, offset);
  }
  // ナノ秒だけが持つ 1 ns の精度は、マイクロ秒側の換算では補わない。
  const nanosPlusOne = 946684799250000n * 1000n + 1n;
  assert.equal(nanosPlusOne / 1_000_000_000n, 946684799n);
  assert.equal(nanosPlusOne % 1_000_000_000n, 250000001n);
});

test("logGroupId: 負数と vi64 超を拒否する", () => {
  assert.throws(() => logGroupId(-1n), /non-negative/);
  assert.throws(() => logGroupId((MAX_VARINT + 1n) * 1_000_000n), /varint maximum/);
  // vi64 の上限ちょうどは受理する。
  assert.equal(logGroupId(MAX_VARINT * 1_000_000n), MAX_VARINT);
});

// [MOQLOG] §5.2: Object ID はその秒の 0 始まりの生成順。
test("logObjectId: 秒内の連番を返す", () => {
  assert.equal(logObjectId(0), 0n);
  assert.equal(logObjectId(1), 1n);
  assert.equal(logObjectId(2), 2n);
});

test("logObjectId: 負数・非整数・安全整数外を拒否する", () => {
  assert.throws(() => logObjectId(-1), /safe integer/);
  assert.throws(() => logObjectId(1.5), /safe integer/);
  assert.throws(() => logObjectId(Number.MAX_SAFE_INTEGER + 1), /safe integer/);
});

// [MOQLOG] §5.2 / §5.8: Prior Group ID Gap は差 - 1。前が不明なら付けない。
test("logPriorGroupIdGap: 差 - 1 を返す", () => {
  assert.equal(logPriorGroupIdGap(946684799n, 946684805n), 5n);
  assert.equal(logPriorGroupIdGap(946684799n, 946684800n), 0n);
  assert.isUndefined(logPriorGroupIdGap(undefined, 946684799n));
});

test("logPriorGroupIdGap: 負数・減少・同値・vi64 超を拒否する", () => {
  assert.throws(() => logPriorGroupIdGap(-1n, 1n), /group ID/);
  assert.throws(() => logPriorGroupIdGap(2n, 1n), /must increase/);
  assert.throws(() => logPriorGroupIdGap(1n, 1n), /must increase/);
  assert.throws(() => logPriorGroupIdGap(undefined, -1n), /group ID/);
  assert.throws(() => logPriorGroupIdGap(MAX_VARINT + 1n, MAX_VARINT), /group ID/);
  assert.throws(() => logPriorGroupIdGap(1n, MAX_VARINT + 1n), /group ID/);
});

test("logGroupId / logPriorGroupIdGap: bigint 以外を拒否する", () => {
  assert.throws(() => logGroupId(1 as unknown as bigint), /must be a bigint/);
  assert.throws(() => logPriorGroupIdGap(1 as unknown as bigint, 2n), /must be a bigint/);
  assert.throws(() => logPriorGroupIdGap(1n, 2 as unknown as bigint), /must be a bigint/);
});

// [MOQLOG] §5.2 / §5.8: End of Group は最終ログの次の Object ID を
// status: END_OF_GROUP、空 payload、properties なしで sendObject に渡す。
test("End of Group: §5.8 の Group と Object ID で sendObject に渡せる", async () => {
  const cases = [
    { micros: 946684799250000n, objectId: 2, groupId: 946684799 },
    { micros: 946684805000120n, objectId: 1, groupId: 946684805 },
  ] as const;
  for (const { micros, objectId, groupId } of cases) {
    assert.equal(Number(logGroupId(micros)), groupId);
    const publisher = new PublisherImpl(["namespace"], "track", 0n, 0n);
    const sentParams: SendObjectParams[] = [];
    publisher.onSendObject = async (params) => {
      sentParams.push(params);
    };
    await publisher.sendObject({
      groupId: Number(logGroupId(micros)),
      objectId: Number(logObjectId(objectId)),
      payload: new Uint8Array(0),
      status: ObjectStatus.END_OF_GROUP,
    });
    assert.equal(sentParams.length, 1);
    const params = sentParams[0];
    assert.isDefined(params);
    assert.equal(params?.groupId, groupId);
    assert.equal(params?.objectId, objectId);
    assert.equal(params?.status, ObjectStatus.END_OF_GROUP);
    assert.equal(params?.payload.byteLength, 0);
    assert.isUndefined(params?.properties);
  }
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
