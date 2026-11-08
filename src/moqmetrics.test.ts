/**
 * MOQ Metrics (moqmetrics) の単体テスト
 * draft-jennings-moq-metrics-03 ([MOQMETRICS]) / draft-ietf-moq-msf-01 §10 (Metrics track)
 *
 * catalog は metrics-03 §5.3、data Object は §5.4 のバイナリ Capture Info / Metric Value。
 * 任意 payload の round-trip は moqmetrics.prop.ts の PBT が検証する。
 * 本ファイルは固定ワイヤ・境界値・エラーパス・各 helper の固有挙動を扱う。
 */

import { test, assert } from "vite-plus/test";
import { IncompleteDataError, ProtocolViolationError, SessionErrorCode } from "./error";

import { formatFullTrackName, formatTrackNamespace, parseTrackNamespace } from "./fullTrackName";
import { resolveCatalogVariables, type Catalog } from "./msf";
import {
  type MetricDescription,
  type MetricType,
  type MetricValueRepresentation,
  type MetricsCaptureInfo,
  type MetricsCatalogHeader,
  METRICS_CAPTURE_OBJECT_ID,
  METRICS_CATALOG_FORMAT_VERSION,
  MOQMETRICS_NAMESPACE_PREFIX,
  MOQMETRICS_NAMESPACE_TEMPLATE,
  decodeMetricDescription,
  decodeMetricValue,
  decodeMetricsCaptureInfo,
  decodeMetricsCatalogHeader,
  encodeMetricDescription,
  encodeMetricValue,
  encodeMetricsCaptureInfo,
  encodeMetricsCatalogHeader,
  metricObjectId,
  metricsCatalogGroupId,
  metricsCatalogTrackName,
  metricsEndOfGroupObjectId,
  metricsGroupId,
  metricsPriorGroupIdGap,
  metricsPriorObjectIdGap,
  metricsTrackNamespace,
  metricsTrackName,
} from "./moqmetrics";
import { encodeVarint, MAX_VARINT } from "./varint";

const GAUGE_UNSIGNED: MetricDescription = {
  metricType: "gauge",
  valueRepresentation: "unsigned",
  name: "cpu",
  unit: "%",
};

const COUNTER_SIGNED: MetricDescription = {
  metricType: "counter",
  valueRepresentation: "signed",
  name: "requests_total",
  unit: "s",
};

const GAUGE_FLOAT: MetricDescription = {
  metricType: "gauge",
  valueRepresentation: "float",
  name: "cpu_temperature",
  unit: "Cel",
};

// decode の構造不正は Object Payload のデコード失敗として MALFORMED_OBJECT に統一する。
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

// [MOQMETRICS] §5.3: Header は Version / Number of Attributes / 各 Key / Value。
test("MetricsCatalogHeader: 空の固定ワイヤ", () => {
  assert.deepEqual(
    encodeMetricsCatalogHeader({ formatVersion: 1n, attributes: [] }),
    new Uint8Array([0x01, 0x00]),
  );
  assert.deepEqual(decodeMetricsCatalogHeader(new Uint8Array([0x01, 0x00])), {
    formatVersion: 1n,
    attributes: [],
  });
});

test("MetricsCatalogHeader: Attributes の固定ワイヤと空の Key", () => {
  const header = {
    formatVersion: 1n,
    attributes: [
      { key: "a", value: "b" },
      { key: "", value: "c" },
    ],
  };
  const expected = new Uint8Array([0x01, 0x02, 0x01, 0x61, 0x01, 0x62, 0x00, 0x01, 0x63]);
  assert.deepEqual(encodeMetricsCatalogHeader(header), expected);
  assert.deepEqual(decodeMetricsCatalogHeader(expected), header);
});

test("MetricsCatalogHeader: 空 Value・BOM・孤立サロゲート", () => {
  const header = { formatVersion: 1n, attributes: [{ key: "a", value: "" }] };
  assert.deepEqual(
    encodeMetricsCatalogHeader(header),
    new Uint8Array([0x01, 0x01, 0x01, 0x61, 0x00]),
  );
  assert.deepEqual(decodeMetricsCatalogHeader(encodeMetricsCatalogHeader(header)), header);
  const bom = { formatVersion: 1n, attributes: [{ key: "a", value: "\uFEFFvalue" }] };
  assert.deepEqual(decodeMetricsCatalogHeader(encodeMetricsCatalogHeader(bom)), bom);
  for (const attribute of [
    { key: "\uD800", value: "" },
    { key: "", value: "\uDC00" },
  ]) {
    assert.throws(
      () => encodeMetricsCatalogHeader({ formatVersion: 1n, attributes: [attribute] }),
      /unpaired surrogate/,
    );
  }
});

test("MetricsCatalogHeader: UTF-8 と重複キー、128 属性", () => {
  const header = {
    formatVersion: 1n,
    attributes: [
      { key: "地域", value: "東京" },
      { key: "地域", value: "大阪" },
    ],
  };
  assert.deepEqual(decodeMetricsCatalogHeader(encodeMetricsCatalogHeader(header)), header);

  const attributes = Array.from({ length: 128 }, (_, index) => ({
    key: `k${index}`,
    value: "a".repeat(128),
  }));
  const encoded = encodeMetricsCatalogHeader({ formatVersion: 1n, attributes });
  // version 1 の後ろの Number of Attributes が 2 バイトの 128。
  assert.deepEqual(encoded.subarray(1, 3), new Uint8Array([0x80, 0x80]));
  assert.deepEqual(decodeMetricsCatalogHeader(encoded), { formatVersion: 1n, attributes });
});

test("MetricsCatalogHeader: 不正 UTF-8 と Description の末尾拡張", () => {
  // version 1 / 1 attribute / key length 1 / 0xff
  assertMalformedObject(
    () => decodeMetricsCatalogHeader(new Uint8Array([0x01, 0x01, 0x01, 0xff])),
    /UTF-8/,
  );
  const encoded = encodeMetricDescription(GAUGE_UNSIGNED);
  assert.deepEqual(decodeMetricDescription(new Uint8Array([...encoded, 0xff])), GAUGE_UNSIGNED);
});

test("MetricsCatalogHeader: 未知 version・長さ超過・切り詰め・末尾無視", () => {
  assertMalformedObject(
    () => decodeMetricsCatalogHeader(new Uint8Array([0x02, 0x00])),
    /formatVersion/,
  );
  assert.throws(
    () => encodeMetricsCatalogHeader({ formatVersion: 2n, attributes: [] }),
    /formatVersion/,
  );
  assertMalformedObject(
    () => decodeMetricsCatalogHeader(new Uint8Array([0x01, 0x01, 0x05])),
    /length/,
  );
  assert.throws(() => decodeMetricsCatalogHeader(new Uint8Array(0)), IncompleteDataError);
  assert.throws(() => decodeMetricsCatalogHeader(new Uint8Array([0x80])), IncompleteDataError);
  const withExtension = new Uint8Array([0x01, 0x00, 0xff]);
  assert.deepEqual(decodeMetricsCatalogHeader(withExtension), {
    formatVersion: 1n,
    attributes: [],
  });
});

// [MOQMETRICS] §5.3: Description は Type / Value Representation / Name / Unit。
test("MetricDescription: 6 組合せの enum ワイヤ値", () => {
  const cases = [
    ["gauge", "unsigned", 0x00, 0x00],
    ["gauge", "signed", 0x00, 0x01],
    ["gauge", "float", 0x00, 0x02],
    ["counter", "unsigned", 0x01, 0x00],
    ["counter", "signed", 0x01, 0x01],
    ["counter", "float", 0x01, 0x02],
  ] as const;
  for (const [metricType, valueRepresentation, typeCode, representationCode] of cases) {
    const encoded = encodeMetricDescription({
      metricType,
      valueRepresentation,
      name: "m",
      unit: "",
    });
    assert.equal(encoded[0], typeCode);
    assert.equal(encoded[1], representationCode);
    assert.equal(decodeMetricDescription(encoded).metricType, metricType);
    assert.equal(decodeMetricDescription(encoded).valueRepresentation, valueRepresentation);
  }
});

test("MetricDescription: §5.10 の cpu_temperature の固定ワイヤ", () => {
  const expected = new Uint8Array([
    0x00, 0x02, 0x0f, 0x63, 0x70, 0x75, 0x5f, 0x74, 0x65, 0x6d, 0x70, 0x65, 0x72, 0x61, 0x74, 0x75,
    0x72, 0x65, 0x03, 0x43, 0x65, 0x6c,
  ]);
  assert.deepEqual(encodeMetricDescription(GAUGE_FLOAT), expected);
  assert.deepEqual(decodeMetricDescription(expected), GAUGE_FLOAT);
});

test("MetricDescription: 空 Unit・不正 Name・UTF-8・切り詰め", () => {
  const noUnit = { ...GAUGE_UNSIGNED, unit: "" };
  assert.deepEqual(decodeMetricDescription(encodeMetricDescription(noUnit)), noUnit);
  for (const name of ["", "cpu-usage", "cpu usage", "cpu.usage", "cpu℃"]) {
    assert.throws(() => encodeMetricDescription({ ...GAUGE_UNSIGNED, name }), /metric name/);
  }
  assertMalformedObject(
    () => decodeMetricDescription(new Uint8Array([0x00, 0x00, 0x01, 0x2d, 0x00])),
    /metric name/,
  );
  assertMalformedObject(
    () => decodeMetricDescription(new Uint8Array([0x00, 0x00, 0x01, 0x80, 0x00])),
    /non-ASCII/,
  );
  assertMalformedObject(
    () => decodeMetricDescription(new Uint8Array([0x00, 0x00, 0x01, 0x61, 0x01, 0xff])),
    /UTF-8/,
  );
  assert.throws(() => decodeMetricDescription(new Uint8Array(0)), IncompleteDataError);
  assert.throws(() => decodeMetricDescription(new Uint8Array([0x80])), IncompleteDataError);
  assertMalformedObject(
    () => decodeMetricDescription(new Uint8Array([0x00, 0x00, 0x05])),
    /length/,
  );
  const units = { ...GAUGE_UNSIGNED, unit: "\uFEFFunit" };
  assert.deepEqual(decodeMetricDescription(encodeMetricDescription(units)), units);
});

test("MetricDescription: 未知 enum・非オブジェクト・型違反を拒否する", () => {
  assertMalformedObject(() => decodeMetricDescription(new Uint8Array([0x02])), /metricType/);
  assertMalformedObject(
    () => decodeMetricDescription(new Uint8Array([0x00, 0x03])),
    /valueRepresentation/,
  );
  for (const metricType of ["histogram", "toString", "constructor"]) {
    assert.throws(
      () =>
        encodeMetricDescription({
          metricType: metricType as unknown as MetricType,
          valueRepresentation: "unsigned",
          name: "cpu",
          unit: "",
        }),
      /metricType/,
    );
  }
  for (const valueRepresentation of ["double", "toString", "constructor"]) {
    assert.throws(
      () =>
        encodeMetricDescription({
          metricType: "gauge",
          valueRepresentation: valueRepresentation as unknown as MetricValueRepresentation,
          name: "cpu",
          unit: "",
        }),
      /valueRepresentation/,
    );
  }
  assert.throws(
    () => encodeMetricDescription(null as unknown as MetricDescription),
    /must be an object: null/,
  );
  assert.throws(
    () =>
      encodeMetricDescription({
        ...GAUGE_UNSIGNED,
        name: null as unknown as string,
      }),
    /metric name/,
  );
  assert.throws(
    () =>
      encodeMetricDescription({
        ...GAUGE_UNSIGNED,
        unit: null as unknown as string,
      }),
    /must be a string/,
  );
});

test("MetricsCatalogHeader: 非オブジェクト・型違反・長さ超過を拒否する", () => {
  assert.throws(
    () => encodeMetricsCatalogHeader(null as unknown as MetricsCatalogHeader),
    /must be an object: null/,
  );
  assert.throws(
    () =>
      encodeMetricsCatalogHeader({
        formatVersion: 1 as unknown as bigint,
        attributes: [],
      }),
    /must be a bigint/,
  );
  assert.throws(
    () =>
      encodeMetricsCatalogHeader({
        formatVersion: 1n,
        attributes: null as unknown as [],
      }),
    /must be an array: null/,
  );
  assert.throws(
    () =>
      encodeMetricsCatalogHeader({
        formatVersion: 1n,
        attributes: [null] as unknown as [],
      }),
    /must be an object: null/,
  );
  assertMalformedObject(
    () => decodeMetricsCatalogHeader(new Uint8Array([0x01, 0x01, 0x00, 0x05])),
    /length/,
  );
});

test("MetricDescription: 128 バイトの Name / Unit と BOM", () => {
  const description = {
    ...GAUGE_UNSIGNED,
    name: "a".repeat(128),
    unit: "\uFEFF" + "b".repeat(128),
  };
  const encoded = encodeMetricDescription(description);
  // Type 0 / Representation 0 の後ろの Name Length が 2 バイトの 128。
  assert.deepEqual(encoded.subarray(2, 4), new Uint8Array([0x80, 0x80]));
  assert.deepEqual(decodeMetricDescription(encoded), description);
});

// [MOQMETRICS] §5.4: Capture Info は Timestamp Offset / Catalog Version。
test("MetricsCaptureInfo: 固定ワイヤと境界値", () => {
  assert.deepEqual(
    encodeMetricsCaptureInfo({ timestampOffset: 0n, catalogVersion: 1n }),
    new Uint8Array([0x00, 0x01]),
  );
  assert.deepEqual(decodeMetricsCaptureInfo(new Uint8Array([0x00, 0x01])), {
    timestampOffset: 0n,
    catalogVersion: 1n,
  });
  // 999999 の vi64 は 0xcf 0x42 0x3f。
  assert.deepEqual(
    encodeMetricsCaptureInfo({ timestampOffset: 999999n, catalogVersion: 2n }),
    new Uint8Array([0xcf, 0x42, 0x3f, 0x02]),
  );
  assert.deepEqual(
    decodeMetricsCaptureInfo(
      encodeMetricsCaptureInfo({ timestampOffset: 999999n, catalogVersion: 2n }),
    ),
    { timestampOffset: 999999n, catalogVersion: 2n },
  );
  assert.throws(
    () => encodeMetricsCaptureInfo({ timestampOffset: 1000000n, catalogVersion: 1n }),
    /timestampOffset/,
  );
  assert.throws(
    () => encodeMetricsCaptureInfo({ timestampOffset: 0n, catalogVersion: 0n }),
    /catalogVersion/,
  );
  assert.throws(
    () => encodeMetricsCaptureInfo({ timestampOffset: 0n, catalogVersion: MAX_VARINT + 1n }),
    /catalogVersion/,
  );
  assert.deepEqual(
    decodeMetricsCaptureInfo(
      encodeMetricsCaptureInfo({ timestampOffset: 0n, catalogVersion: MAX_VARINT }),
    ),
    { timestampOffset: 0n, catalogVersion: MAX_VARINT },
  );
});

test("MetricsCaptureInfo: 型違反と範囲外を拒否する", () => {
  assert.throws(
    () => encodeMetricsCaptureInfo(null as unknown as MetricsCaptureInfo),
    /must be an object: null/,
  );
  assert.throws(
    () =>
      encodeMetricsCaptureInfo({
        timestampOffset: 1 as unknown as bigint,
        catalogVersion: 1n,
      }),
    /timestampOffset/,
  );
  assert.throws(
    () =>
      encodeMetricsCaptureInfo({
        timestampOffset: -1n,
        catalogVersion: 1n,
      }),
    /timestampOffset/,
  );
  assert.throws(
    () =>
      encodeMetricsCaptureInfo({
        timestampOffset: 0n,
        catalogVersion: 1 as unknown as bigint,
      }),
    /catalogVersion/,
  );
});

test("MetricsCaptureInfo: 不正値・切り詰め・末尾無視", () => {
  assertMalformedObject(() => decodeMetricsCaptureInfo(encodeVarint(1000000n)), /timestampOffset/);
  assertMalformedObject(
    () => decodeMetricsCaptureInfo(new Uint8Array([0x00, 0x00])),
    /catalogVersion/,
  );
  assert.throws(() => decodeMetricsCaptureInfo(new Uint8Array(0)), IncompleteDataError);
  assert.throws(() => decodeMetricsCaptureInfo(new Uint8Array([0x00, 0x80])), IncompleteDataError);
  // 2 フィールドの後ろは将来拡張として無視する。
  assert.deepEqual(decodeMetricsCaptureInfo(new Uint8Array([0x00, 0x01, 0xff])), {
    timestampOffset: 0n,
    catalogVersion: 1n,
  });
});

// [MOQMETRICS] §5.4: unsigned は payload 全体が 1 つの vi64。
test("MetricValue: unsigned の固定ワイヤと範囲", () => {
  assert.deepEqual(encodeMetricValue(GAUGE_UNSIGNED, 0n), new Uint8Array([0x00]));
  assert.deepEqual(
    encodeMetricValue(GAUGE_UNSIGNED, MAX_VARINT),
    new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]),
  );
  const large = (1n << 53n) + 1n;
  assert.deepEqual(
    encodeMetricValue(GAUGE_UNSIGNED, large),
    new Uint8Array([0xfe, 0x20, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01]),
  );
  assert.equal(decodeMetricValue(GAUGE_UNSIGNED, encodeMetricValue(GAUGE_UNSIGNED, large)), large);
  assert.equal(decodeMetricValue(GAUGE_UNSIGNED, encodeMetricValue(GAUGE_UNSIGNED, 42n)), 42n);
  assert.throws(() => encodeMetricValue(GAUGE_UNSIGNED, -1n), /unsigned/);
  assert.throws(() => encodeMetricValue(GAUGE_UNSIGNED, MAX_VARINT + 1n), /unsigned/);
  assert.throws(() => encodeMetricValue(GAUGE_UNSIGNED, 1), /bigint/);
  assertMalformedObject(
    () => decodeMetricValue(GAUGE_UNSIGNED, new Uint8Array([0x00, 0x00])),
    /trailing bytes/,
  );
  assert.throws(() => decodeMetricValue(GAUGE_UNSIGNED, new Uint8Array(0)), IncompleteDataError);
});

// [MOQMETRICS] §5.4: signed は network byte order の 8 バイト。
test("MetricValue: signed の固定ワイヤと範囲", () => {
  assert.deepEqual(
    encodeMetricValue(COUNTER_SIGNED, -(1n << 63n)),
    new Uint8Array([0x80, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
  );
  assert.deepEqual(
    encodeMetricValue(COUNTER_SIGNED, (1n << 63n) - 1n),
    new Uint8Array([0x7f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]),
  );
  assert.equal(decodeMetricValue(COUNTER_SIGNED, encodeMetricValue(COUNTER_SIGNED, -1n)), -1n);
  assert.throws(() => encodeMetricValue(COUNTER_SIGNED, 1n << 63n), /signed/);
  assert.throws(() => encodeMetricValue(COUNTER_SIGNED, -(1n << 63n) - 1n), /signed/);
  assert.throws(() => encodeMetricValue(COUNTER_SIGNED, 1), /bigint/);
  assertMalformedObject(() => decodeMetricValue(COUNTER_SIGNED, new Uint8Array(7)), /length/);
});

// [MOQMETRICS] §5.4: float は IEEE 754 binary64 の 8 バイト。
test("MetricValue: float の固定ワイヤと NaN / Infinity / -0", () => {
  assert.deepEqual(
    encodeMetricValue(GAUGE_FLOAT, 45.1),
    new Uint8Array([0x40, 0x46, 0x8c, 0xcc, 0xcc, 0xcc, 0xcc, 0xcd]),
  );
  assert.deepEqual(
    encodeMetricValue(GAUGE_FLOAT, Number.POSITIVE_INFINITY),
    new Uint8Array([0x7f, 0xf0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
  );
  assert.deepEqual(
    encodeMetricValue(GAUGE_FLOAT, Number.NEGATIVE_INFINITY),
    new Uint8Array([0xff, 0xf0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
  );
  assert.deepEqual(
    encodeMetricValue(GAUGE_FLOAT, -0),
    new Uint8Array([0x80, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
  );
  assert.isTrue(
    Number.isNaN(decodeMetricValue(GAUGE_FLOAT, new Uint8Array([0x7f, 0xf8, 0, 0, 0, 0, 0, 0]))),
  );
  assert.throws(() => encodeMetricValue(GAUGE_FLOAT, 1n), /number/);
  assertMalformedObject(() => decodeMetricValue(GAUGE_FLOAT, new Uint8Array(7)), /length/);
});

test("MetricValue: catalog の Description だけで解釈できる", () => {
  const description = decodeMetricDescription(encodeMetricDescription(GAUGE_UNSIGNED));
  assert.equal(decodeMetricValue(description, encodeMetricValue(description, 7n)), 7n);
});

// [MOQMETRICS] §5.4: data track の Group ID は Unix epoch ミリ秒をそのまま使う。
test("metricsGroupId: 0 / 2^53-1 / 2^64-1 をそのまま返す", () => {
  assert.equal(metricsGroupId(0n), 0n);
  assert.equal(metricsGroupId((1n << 53n) - 1n), (1n << 53n) - 1n);
  assert.equal(metricsGroupId(MAX_VARINT), MAX_VARINT);
  assert.equal(Number(metricsGroupId((1n << 53n) - 1n)), Number.MAX_SAFE_INTEGER);
  // 2^53 以上は Number() で値が変わり得る。
  assert.notEqual(BigInt(Number(metricsGroupId(MAX_VARINT))), MAX_VARINT);
});

test("metricsGroupId: 負数・2^64・非 bigint を拒否する", () => {
  assert.throws(() => metricsGroupId(-1n), /must be 0/);
  assert.throws(() => metricsGroupId(MAX_VARINT + 1n), /must be 0/);
  assert.throws(() => metricsGroupId(1 as unknown as bigint), /must be a bigint/);
});

test("Prior Group ID Gap: §5.10.2 の 999 / 0 / undefined", () => {
  assert.equal(metricsPriorGroupIdGap(1720367991000n, 1720367992000n), 999n);
  assert.equal(metricsPriorGroupIdGap(1720367991000n, 1720367991001n), 0n);
  assert.isUndefined(metricsPriorGroupIdGap(undefined, 1720367991000n));
  assert.throws(() => metricsPriorGroupIdGap(2n, 1n), /metrics group ID must increase/);
  assert.throws(() => metricsPriorGroupIdGap(1n, 1n), /metrics group ID must increase/);
  assert.throws(() => metricsPriorGroupIdGap(-1n, 1n), /must be 0/);
  assert.throws(() => metricsPriorGroupIdGap(1 as unknown as bigint, 2n), /must be a bigint/);
  assert.throws(() => metricsPriorGroupIdGap(1n, MAX_VARINT + 1n), /must be 0/);
});

test("Prior Object ID Gap: 1 / undefined / 減少拒否", () => {
  assert.equal(metricsPriorObjectIdGap(0n, 2n), 1n);
  assert.isUndefined(metricsPriorObjectIdGap(0n, 1n));
  assert.throws(() => metricsPriorObjectIdGap(2n, 1n), /metrics object ID must increase/);
  assert.throws(() => metricsPriorObjectIdGap(1n, 1n), /metrics object ID must increase/);
  assert.throws(() => metricsPriorObjectIdGap(-1n, 1n), /must be 0/);
  assert.throws(() => metricsPriorObjectIdGap(1 as unknown as bigint, 2n), /must be a bigint/);
  assert.throws(() => metricsPriorObjectIdGap(1n, MAX_VARINT + 1n), /must be 0/);
});

test("End of Group: 最大 Object ID + 1", () => {
  assert.equal(metricsEndOfGroupObjectId(2n), 3n);
  assert.equal(metricsEndOfGroupObjectId(MAX_VARINT - 1n), MAX_VARINT);
  assert.throws(() => metricsEndOfGroupObjectId(MAX_VARINT), /largest object ID/);
  assert.throws(() => metricsEndOfGroupObjectId(-1n), /largest object ID/);
  assert.throws(() => metricsEndOfGroupObjectId(1 as unknown as bigint), /largest object ID/);
  assert.throws(() => metricsEndOfGroupObjectId(null as unknown as bigint), /largest object ID/);
});

// [MOQMETRICS] §5.3: 同じ catalog version の Object N を複数の data track が参照できる。
test("Metric Index: track A / B が version 1 の同じ Index を参照し version 2 で維持・再割当する", () => {
  const version1 = metricsCatalogGroupId(1n);
  const cpu = decodeMetricDescription(encodeMetricDescription(GAUGE_UNSIGNED));
  const memory = decodeMetricDescription(
    encodeMetricDescription({ ...GAUGE_UNSIGNED, name: "memory", unit: "bytes" }),
  );
  const cpuBytes = encodeMetricDescription(cpu);
  const memoryBytes = encodeMetricDescription(memory);
  const trackA = new Map([
    [metricObjectId(1n), decodeMetricDescription(cpuBytes)],
    [metricObjectId(2n), decodeMetricDescription(memoryBytes)],
  ]);
  const trackB = new Map([
    [metricObjectId(1n), decodeMetricDescription(cpuBytes)],
    [metricObjectId(2n), decodeMetricDescription(memoryBytes)],
  ]);
  assert.equal(version1, 1n);
  assert.deepEqual(trackA.get(metricObjectId(1n)), trackB.get(metricObjectId(1n)));
  assert.equal(trackA.get(metricObjectId(1n))?.name, "cpu");
  assert.equal(trackB.get(metricObjectId(2n))?.name, "memory");

  const disk = decodeMetricDescription(
    encodeMetricDescription({ ...GAUGE_UNSIGNED, name: "disk", unit: "bytes" }),
  );
  const catalogV2 = new Map(trackA);
  catalogV2.set(metricObjectId(2n), disk);
  assert.equal(metricsCatalogGroupId(2n), 2n);
  assert.equal(catalogV2.get(metricObjectId(1n))?.name, "cpu");
  assert.equal(catalogV2.get(metricObjectId(2n))?.name, "disk");
  assert.equal(trackA.get(metricObjectId(2n))?.name, "memory");
});

// moq-metrics-03 §5.1: Track Namespace は ("metrics.moq.arpa", "v1", resourceID) の 3 field。
test("metricsTrackNamespace: 3 field の Track Namespace を返す", () => {
  assert.deepEqual(MOQMETRICS_NAMESPACE_PREFIX, ["metrics.moq.arpa", "v1"]);
  const namespace = metricsTrackNamespace("8f2c4a1b0e9d7c63");
  assert.deepEqual(namespace, ["metrics.moq.arpa", "v1", "8f2c4a1b0e9d7c63"]);
  assert.equal(formatTrackNamespace(namespace), "metrics.2emoq.2earpa-v1-8f2c4a1b0e9d7c63");
  assert.deepEqual(parseTrackNamespace(formatTrackNamespace(namespace)), namespace);
  assert.equal(formatFullTrackName(namespace, "4"), "metrics.2emoq.2earpa-v1-8f2c4a1b0e9d7c63--4");
});

// moq-metrics-03 §6: publishTracks の namespace は §8.8 形式で %resourceId% を保持する。
test("MOQMETRICS_NAMESPACE_TEMPLATE: %resourceId% を保持し 3 field に展開できる", () => {
  assert.equal(MOQMETRICS_NAMESPACE_TEMPLATE, "metrics.2emoq.2earpa-v1-%resourceId%");
  const catalog: Catalog = {
    version: "draft-01",
    tracks: [],
    publishTracks: [
      {
        name: "4",
        namespace: MOQMETRICS_NAMESPACE_TEMPLATE,
        packaging: "moqmetrics",
        role: "metrics",
        isLive: true,
      },
    ],
  };
  const resolved = resolveCatalogVariables(catalog, { resourceId: "8f2c4a1b0e9d7c63" });
  const namespace = resolved.publishTracks?.[0]?.namespace;
  assert.equal(namespace, "metrics.2emoq.2earpa-v1-8f2c4a1b0e9d7c63");
  assert.deepEqual(parseTrackNamespace(namespace ?? ""), metricsTrackNamespace("8f2c4a1b0e9d7c63"));
  assert.throws(() => parseTrackNamespace(MOQMETRICS_NAMESPACE_TEMPLATE), /%/);
  for (const resourceId of [
    "",
    "res-1",
    "8F2C4A1B0E9D7C63",
    "8f2c4a1b0e9d7c6",
    "8f2c4a1b0e9d7c630",
    "8f2c4a1b0e9d7c6g",
    "8f2c4a1b0e9d7c63\n",
    " 8f2c4a1b0e9d7c63",
  ]) {
    assert.throws(() => metricsTrackNamespace(resourceId), /resourceId/);
  }
  const escaped = formatTrackNamespace(["metrics.moq.arpa", "v1", "%resourceId%"]);
  assert.equal(escaped, "metrics.2emoq.2earpa-v1-.25resourceId.25");
});

// moq-metrics-03 §5.1 / §5.2: Track Name は granularity level の ASCII 数字 1 バイト。
test("metricsTrackName: 境界値は ASCII 数字 1 バイト、範囲外は throw", () => {
  assert.deepEqual(metricsTrackName(0), new TextEncoder().encode("0"));
  assert.deepEqual(metricsTrackName(7), new TextEncoder().encode("7"));
  assert.throws(() => metricsTrackName(-1), /0-7/);
  assert.throws(() => metricsTrackName(8), /0-7/);
  assert.throws(() => metricsTrackName(1.5), /0-7/);
  assert.throws(() => metricsTrackName(Number.NaN), /0-7/);
});

test("metricsCatalogTrackName: ASCII の catalog を返す", () => {
  assert.deepEqual(metricsCatalogTrackName(), new TextEncoder().encode("catalog"));
  assert.equal(metricsCatalogTrackName().length, 7);
  assert.notDeepEqual(metricsCatalogTrackName(), metricsTrackName(4));
});

// [MOQMETRICS] §5.3: Object ID 0 は Header / Capture Info、Object N は Metric Index N。
test("metricObjectId: 1 / 2 / 2^64-2 をそのまま返し、0 / 2^64-1 を拒否する", () => {
  assert.equal(metricObjectId(1n), 1n);
  assert.equal(metricObjectId(2n), 2n);
  assert.equal(metricObjectId(MAX_VARINT - 1n), MAX_VARINT - 1n);
  assert.equal(Number(metricObjectId((1n << 53n) - 2n)), Number.MAX_SAFE_INTEGER - 1);
  assert.throws(() => metricObjectId(0n), /metric index/);
  assert.throws(() => metricObjectId(MAX_VARINT), /metric index/);
  assert.throws(() => metricObjectId(-1n), /metric index/);
  assert.throws(() => metricObjectId(1 as unknown as bigint), /must be a bigint/);
  assert.throws(() => metricObjectId(null as unknown as bigint), /must be a bigint/);
});

test("metricsCatalogGroupId: 1 / 2^64-1 をそのまま返し、0 / 2^64 を拒否する", () => {
  assert.equal(metricsCatalogGroupId(1n), 1n);
  assert.equal(metricsCatalogGroupId(MAX_VARINT), MAX_VARINT);
  assert.equal(Number(metricsCatalogGroupId((1n << 53n) - 1n)), Number.MAX_SAFE_INTEGER);
  assert.throws(() => metricsCatalogGroupId(0n), /catalog version/);
  assert.throws(() => metricsCatalogGroupId(-1n), /catalog version/);
  assert.throws(() => metricsCatalogGroupId(MAX_VARINT + 1n), /catalog version/);
  assert.throws(() => metricsCatalogGroupId(1 as unknown as bigint), /must be a bigint/);
  assert.throws(() => metricsCatalogGroupId(null as unknown as bigint), /must be a bigint/);
});

test("METRICS_CAPTURE_OBJECT_ID と format Version は別物", () => {
  assert.equal(METRICS_CAPTURE_OBJECT_ID, 0n);
  assert.equal(METRICS_CATALOG_FORMAT_VERSION, 1n);
  assert.equal(metricsCatalogGroupId(2n), 2n);
});
