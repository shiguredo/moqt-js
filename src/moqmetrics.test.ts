/**
 * MOQ Metrics (moqmetrics) の単体テスト
 * draft-jennings-moq-metrics-03 ([MOQMETRICS]) / draft-ietf-moq-msf-01 §10 (Metrics track)
 *
 * catalog は metrics-03 §5.3、data Object は引き続き metrics-02 §3 の JSON 形式である。
 * 任意の JSON object / catalog payload の round-trip は moqmetrics.prop.ts の PBT が検証する。
 * 本ファイルは固定ワイヤ・境界値・エラーパス・各 helper の固有挙動を扱う。
 */

import { test, assert } from "vite-plus/test";
import { IncompleteDataError, ProtocolViolationError, SessionErrorCode } from "./error";

import { encodeJson } from "./testSupport/helpers";
import { formatFullTrackName, formatTrackNamespace, parseTrackNamespace } from "./fullTrackName";
import { MAX_VARINT } from "./varint";

import { resolveCatalogVariables, type Catalog } from "./msf";
import {
  type MetricType,
  type MetricValueRepresentation,
  METRICS_CAPTURE_OBJECT_ID,
  METRICS_CATALOG_FORMAT_VERSION,
  MOQMETRICS_NAMESPACE_PREFIX,
  MOQMETRICS_NAMESPACE_TEMPLATE,
  encodeCaptureObject,
  decodeCaptureObject,
  encodeMetricObject,
  decodeMetricObject,
  metricsCatalogGroupId,
  metricsCatalogTrackName,
  metricsGroupId,
  metricObjectId,
  encodeMetricsCatalogHeader,
  decodeMetricsCatalogHeader,
  encodeMetricDescription,
  decodeMetricDescription,
  type MetricsCatalogHeader,
  type MetricDescription,
  metricsTrackNamespace,
  metricsTrackName,
} from "./moqmetrics";

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

// Object ID 0（capture timestamp + attributes）と Object ID 1 以降（metric name-value pair）の
// round-trip は moqmetrics.prop.ts の PBT が任意の内容で検証する。
// 旧 metrics-02 §3.1 の Object 0 例をテストベクタとしてデコードできることを検証する。
test("MetricsCaptureObject: 旧 metrics-02 §3.1 の例を round-trip する", () => {
  const vector =
    '{"capture_timestamp":1720367991,"attributes":[{"location":"us-east-2"},{"os":"ubuntu20.4"}]}';
  const decoded = decodeCaptureObject(new TextEncoder().encode(vector));
  assert.equal(decoded.capture_timestamp, 1720367991);
  assert.deepEqual(decoded.attributes, [{ location: "us-east-2" }, { os: "ubuntu20.4" }]);

  const redecoded = decodeCaptureObject(encodeCaptureObject(decoded));
  assert.equal(redecoded.capture_timestamp, 1720367991);
});

// 旧 metrics-02 §3.1 の Object 1 / Object 2 例をテストベクタとして検証する。
// 注意: 旧 metrics-02 §3.1 の Object 1 例は value: 99 のキーに引用符がなく JSON として不正。修正版を使う。
test("MetricObject: 旧 metrics-02 §3.1 の例を round-trip する", () => {
  const intVector = '{"metric_name":"cpu_usage_percentage","value":99}';
  const intDecoded = decodeMetricObject(new TextEncoder().encode(intVector));
  assert.equal(intDecoded.metric_name, "cpu_usage_percentage");
  assert.equal(intDecoded.value, 99);

  // float64 の値（Object 2 例）
  const floatVector = '{"metric_name":"cpu_temperature","value":45.1}';
  const floatDecoded = decodeMetricObject(new TextEncoder().encode(floatVector));
  assert.equal(floatDecoded.metric_name, "cpu_temperature");
  assert.equal(floatDecoded.value, 45.1);
});

// metric_name は optional（省略時は直近 group の同一 Object ID の metric name を継承）。
test("MetricObject: metric_name 省略（value のみ）を round-trip する", () => {
  const vector = '{"value":78}';
  const decoded = decodeMetricObject(new TextEncoder().encode(vector));
  assert.isUndefined(decoded.metric_name);
  assert.equal(decoded.value, 78);
});

// payload は JSON object でなければならない（旧 metrics-02 §3）。
test("Metrics payload: JSON object でないと throw", () => {
  assert.throws(
    () => decodeCaptureObject(new TextEncoder().encode("[1,2,3]")),
    /must be a JSON object/,
  );
  assert.throws(
    () => decodeMetricObject(new TextEncoder().encode('"str"')),
    /must be a JSON object/,
  );
});

test("Metrics payload: 不正な JSON は throw", () => {
  assert.throws(
    () => decodeCaptureObject(new TextEncoder().encode("{not json")),
    /invalid moqmetrics capture object payload JSON/,
  );
  assert.throws(
    () => decodeMetricObject(new TextEncoder().encode("{not json")),
    /invalid moqmetrics metric object payload JSON/,
  );
});

// data track の Group ID は msf-01 §10.3 の Unix epoch ミリ秒を 62-bit に truncate した値
// （truncate は旧 metrics-02 §3）。62-bit の境界値は他のテストで網羅しないため、ここで固定する。
test("metricsGroupId: Unix epoch ミリ秒を 62-bit に truncate する", () => {
  // 62-bit 以内の値はそのまま
  assert.equal(metricsGroupId(1720367991000n), 1720367991000n);
  // 62-bit を超える値は下位 62-bit に truncate される
  const over = (1n << 62n) + 5n;
  assert.equal(metricsGroupId(over), 5n);
  // 境界値（62-bit 最大）はそのまま
  assert.equal(metricsGroupId((1n << 62n) - 1n), (1n << 62n) - 1n);
});

test("metricsGroupId: 負の timestamp は throw", () => {
  assert.throws(() => metricsGroupId(-1n), /non-negative/);
});

// [MOQMETRICS] §5.3 / §5.4: Object ID 0 は Header / Capture Info、Object N は Metric Index N。
test("metricObjectId: Metric Index をそのまま Object ID として返す", () => {
  assert.equal(METRICS_CAPTURE_OBJECT_ID, 0n);
  assert.equal(metricObjectId(1n), 1n);
  assert.equal(metricObjectId(2n), 2n);
  assert.equal(metricObjectId(MAX_VARINT - 1n), MAX_VARINT - 1n);
});

test("metricObjectId: sendObject の安全整数境界", () => {
  const maxDataIndex = (1n << 53n) - 2n;
  assert.equal(Number(metricObjectId(maxDataIndex)), Number.MAX_SAFE_INTEGER - 1);
  assert.isTrue(Number.isSafeInteger(Number(metricObjectId(maxDataIndex))));
  assert.equal(Number(metricObjectId(maxDataIndex + 1n)), Number.MAX_SAFE_INTEGER);
});

test("metricObjectId: 0 / 2^64-1 / 負数 / 非 bigint は throw", () => {
  assert.throws(() => metricObjectId(0n), /metric index/);
  assert.throws(() => metricObjectId(MAX_VARINT), /metric index/);
  assert.throws(() => metricObjectId(-1n), /metric index/);
  assert.throws(() => metricObjectId(1 as unknown as bigint), /must be a bigint/);
  assert.throws(() => metricObjectId(null as unknown as bigint), /must be a bigint: null/);
});

// [MOQMETRICS] §5.3: catalog の Group ID は catalog version（1 始まり）。
test("metricsCatalogGroupId: version をそのまま Group ID として返す", () => {
  assert.equal(metricsCatalogGroupId(1n), 1n);
  assert.equal(metricsCatalogGroupId(2n), 2n);
  assert.equal(metricsCatalogGroupId(MAX_VARINT), MAX_VARINT);
  // format Version は 1 のまま、catalog の Group ID だけを 5 に進められる。
  assert.equal(METRICS_CATALOG_FORMAT_VERSION, 1n);
  assert.equal(metricsCatalogGroupId(5n), 5n);
});

test("metricsCatalogGroupId: sendObject の安全整数境界", () => {
  const maxVersion = (1n << 53n) - 1n;
  assert.equal(Number(metricsCatalogGroupId(maxVersion)), Number.MAX_SAFE_INTEGER);
  assert.isTrue(Number.isSafeInteger(Number(metricsCatalogGroupId(maxVersion))));
});

test("metricsCatalogGroupId: 0 / 2^64 / 負数 / 非 bigint は throw", () => {
  assert.throws(() => metricsCatalogGroupId(0n), /catalog version/);
  assert.throws(() => metricsCatalogGroupId(MAX_VARINT + 1n), /catalog version/);
  assert.throws(() => metricsCatalogGroupId(-1n), /catalog version/);
  assert.throws(() => metricsCatalogGroupId(1 as unknown as bigint), /must be a bigint/);
  assert.throws(() => metricsCatalogGroupId(null as unknown as bigint), /must be a bigint: null/);
});

// decode エラーは Object Payload のデコード失敗として MALFORMED_OBJECT に統一する。
test("MetricsCatalogHeader: オブジェクトでない Header を拒否する", () => {
  assert.throws(
    () => encodeMetricsCatalogHeader(null as unknown as MetricsCatalogHeader),
    /must be an object: null/,
  );
});

test("MetricDescription: オブジェクトでない Description を拒否する", () => {
  assert.throws(
    () => encodeMetricDescription(null as unknown as MetricDescription),
    /must be an object: null/,
  );
});

test("MetricsCatalogHeader: 実行時の型違反と Value 長超過を拒否する", () => {
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
        formatVersion: null as unknown as bigint,
        attributes: [],
      }),
    /must be a bigint: null/,
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
    /must be an object/,
  );
  // version 1 / 1 attribute / key 0 / value length 5（残り 0 バイト）
  assertMalformedObject(
    () => decodeMetricsCatalogHeader(new Uint8Array([0x01, 0x01, 0x00, 0x05])),
    /length/,
  );
});

// [MOQMETRICS] §5.3: Header は Version / Number of Attributes / 各 Key / Value。
test("MetricsCatalogHeader: 空の Header の固定ワイヤ", () => {
  assert.deepEqual(
    encodeMetricsCatalogHeader({ formatVersion: 1n, attributes: [] }),
    new Uint8Array([0x01, 0x00]),
  );
  assert.deepEqual(decodeMetricsCatalogHeader(new Uint8Array([0x01, 0x00])), {
    formatVersion: 1n,
    attributes: [],
  });
});

test("MetricsCatalogHeader: Attributes の固定ワイヤ（空の Key を含む）", () => {
  // version 1 / 2 attributes / "a" -> "b" / "" -> "c"
  const expected = new Uint8Array([0x01, 0x02, 0x01, 0x61, 0x01, 0x62, 0x00, 0x01, 0x63]);
  const header: MetricsCatalogHeader = {
    formatVersion: 1n,
    attributes: [
      { key: "a", value: "b" },
      { key: "", value: "c" },
    ],
  };
  assert.deepEqual(encodeMetricsCatalogHeader(header), expected);
  assert.deepEqual(decodeMetricsCatalogHeader(expected), header);
});

test("MetricsCatalogHeader: 空の Value と孤立サロゲート", () => {
  const header: MetricsCatalogHeader = {
    formatVersion: 1n,
    attributes: [{ key: "a", value: "" }],
  };
  assert.deepEqual(decodeMetricsCatalogHeader(encodeMetricsCatalogHeader(header)), header);
  assert.throws(
    () =>
      encodeMetricsCatalogHeader({
        formatVersion: 1n,
        attributes: [{ key: "\uD800", value: "" }],
      }),
    /unpaired surrogate/,
  );
  assert.throws(
    () =>
      encodeMetricsCatalogHeader({
        formatVersion: 1n,
        attributes: [{ key: "", value: "\uDC00" }],
      }),
    /unpaired surrogate/,
  );
});

test("MetricsCatalogHeader: UTF-8 の Key / Value と重複キーを round-trip する", () => {
  const header: MetricsCatalogHeader = {
    formatVersion: 1n,
    attributes: [
      { key: "地域", value: "東京" },
      { key: "地域", value: "大阪" },
    ],
  };
  assert.deepEqual(decodeMetricsCatalogHeader(encodeMetricsCatalogHeader(header)), header);
});

test("MetricsCatalogHeader: 未知の formatVersion と長さ超過を拒否する", () => {
  assertMalformedObject(
    () => decodeMetricsCatalogHeader(new Uint8Array([0x02, 0x00])),
    /formatVersion/,
  );
  assert.throws(
    () => encodeMetricsCatalogHeader({ formatVersion: 2n, attributes: [] }),
    /formatVersion/,
  );
  // version 1 / 1 attribute / key length 5（残り 0 バイト）
  assertMalformedObject(
    () => decodeMetricsCatalogHeader(new Uint8Array([0x01, 0x01, 0x05])),
    /length/,
  );
});

test("MetricsCatalogHeader: 128 バイトの Value と 128 個の Attributes", () => {
  const value = "a".repeat(128);
  const attributes = Array.from({ length: 128 }, (_, index) => ({
    key: `k${index}`,
    value,
  }));
  const header: MetricsCatalogHeader = { formatVersion: 1n, attributes };
  const encoded = encodeMetricsCatalogHeader(header);
  // version 1 の後ろの Number of Attributes が 2 バイトの 128。
  assert.deepEqual(encoded.subarray(1, 3), new Uint8Array([0x80, 0x80]));
  assert.deepEqual(decodeMetricsCatalogHeader(encoded), header);
});

test("MetricsCatalogHeader: 不正 UTF-8 と BOM を扱う", () => {
  // version 1 / 1 attribute / key length 1 / 0xff
  assert.throws(
    () => decodeMetricsCatalogHeader(new Uint8Array([0x01, 0x01, 0x01, 0xff])),
    ProtocolViolationError,
    /UTF-8/,
  );
  const header: MetricsCatalogHeader = {
    formatVersion: 1n,
    attributes: [{ key: "a", value: "\uFEFFvalue" }],
  };
  assert.deepEqual(decodeMetricsCatalogHeader(encodeMetricsCatalogHeader(header)), header);
});

test("MetricsCatalogHeader: 切り詰めと末尾の将来拡張バイト", () => {
  assert.throws(() => decodeMetricsCatalogHeader(new Uint8Array(0)), IncompleteDataError);
  // version の vi64 が途中で切れている / attribute count が無い
  assert.throws(() => decodeMetricsCatalogHeader(new Uint8Array([0x80])), IncompleteDataError);
  assert.throws(() => decodeMetricsCatalogHeader(new Uint8Array([0x01])), IncompleteDataError);
  const encoded = encodeMetricsCatalogHeader({ formatVersion: 1n, attributes: [] });
  const withExtension = new Uint8Array([...encoded, 0xff]);
  assert.deepEqual(decodeMetricsCatalogHeader(withExtension), {
    formatVersion: 1n,
    attributes: [],
  });
  // 空 Value の固定ワイヤ: version 1 / 1 attribute / "a" / ""
  assert.deepEqual(
    encodeMetricsCatalogHeader({
      formatVersion: 1n,
      attributes: [{ key: "a", value: "" }],
    }),
    new Uint8Array([0x01, 0x01, 0x01, 0x61, 0x00]),
  );
});

// [MOQMETRICS] §5.3: Description は Type / Value Representation / Name / Unit。
test("MetricDescription: 固定ワイヤと round-trip", () => {
  const description: MetricDescription = {
    metricType: "gauge",
    valueRepresentation: "unsigned",
    name: "cpu",
    unit: "%",
  };
  // gauge 0 / unsigned 0 / name length 3 "cpu" / unit length 1 "%"
  const expected = new Uint8Array([0x00, 0x00, 0x03, 0x63, 0x70, 0x75, 0x01, 0x25]);
  assert.deepEqual(encodeMetricDescription(description), expected);
  assert.deepEqual(decodeMetricDescription(expected), description);
});

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
  const encoded = encodeMetricDescription({
    metricType: "gauge",
    valueRepresentation: "float",
    name: "cpu_temperature",
    unit: "Cel",
  });
  const expected = new Uint8Array([
    0x00, 0x02, 0x0f, 0x63, 0x70, 0x75, 0x5f, 0x74, 0x65, 0x6d, 0x70, 0x65, 0x72, 0x61, 0x74, 0x75,
    0x72, 0x65, 0x03, 0x43, 0x65, 0x6c,
  ]);
  assert.deepEqual(encoded, expected);
  assert.equal(decodeMetricDescription(expected).valueRepresentation, "float");
});

test("MetricDescription: 空の Unit と孤立サロゲート", () => {
  const description: MetricDescription = {
    metricType: "gauge",
    valueRepresentation: "unsigned",
    name: "cpu",
    unit: "",
  };
  assert.deepEqual(decodeMetricDescription(encodeMetricDescription(description)), description);
  assert.throws(
    () =>
      encodeMetricDescription({
        metricType: "gauge",
        valueRepresentation: "unsigned",
        name: "cpu",
        unit: "\uD800",
      }),
    /unpaired surrogate/,
  );
});

test("MetricDescription: UTF-8 の Unit を round-trip する", () => {
  const description: MetricDescription = {
    metricType: "counter",
    valueRepresentation: "float",
    name: "requests_total",
    unit: "件",
  };
  assert.deepEqual(decodeMetricDescription(encodeMetricDescription(description)), description);
});

test("MetricDescription: 未知の Metric Type / Value Representation を拒否する", () => {
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
});

test("MetricDescription: 128 バイトの Name / Unit と不正 ASCII", () => {
  const name = "a".repeat(128);
  const unit = "b".repeat(128);
  const description: MetricDescription = {
    metricType: "gauge",
    valueRepresentation: "unsigned",
    name,
    unit,
  };
  const encoded = encodeMetricDescription(description);
  // Type 0 / Representation 0 の後ろの Name Length が 2 バイトの 128。
  assert.deepEqual(encoded.subarray(2, 4), new Uint8Array([0x80, 0x80]));
  assert.deepEqual(decodeMetricDescription(encoded), description);
  // name length 1 / byte 0x80
  assertMalformedObject(
    () => decodeMetricDescription(new Uint8Array([0x00, 0x00, 0x01, 0x80, 0x00])),
    /non-ASCII/,
  );
  // name "a" / unit length 1 / byte 0xff
  assertMalformedObject(
    () => decodeMetricDescription(new Uint8Array([0x00, 0x00, 0x01, 0x61, 0x01, 0xff])),
    /UTF-8/,
  );
  // BOM は Unit の一部として保持する。
  const bomDescription: MetricDescription = {
    metricType: "gauge",
    valueRepresentation: "unsigned",
    name: "cpu",
    unit: "\uFEFFunit",
  };
  assert.deepEqual(
    decodeMetricDescription(encodeMetricDescription(bomDescription)),
    bomDescription,
  );
});

test("MetricDescription: 不正な Name を拒否する", () => {
  for (const name of ["", "cpu-usage", "cpu usage", "cpu.usage", "cpu℃"]) {
    assert.throws(
      () =>
        encodeMetricDescription({
          metricType: "gauge",
          valueRepresentation: "unsigned",
          name,
          unit: "",
        }),
      /metric name/,
    );
  }
  // type 0 / representation 0 / name length 1 "-" / unit length 0
  assertMalformedObject(
    () => decodeMetricDescription(new Uint8Array([0x00, 0x00, 0x01, 0x2d, 0x00])),
    /metric name/,
  );
  // type 0 / representation 0 / name length 0 / unit length 0
  assertMalformedObject(
    () => decodeMetricDescription(new Uint8Array([0x00, 0x00, 0x00, 0x00])),
    /metric name/,
  );
});

test("MetricDescription: 実行時の型違反と Unit 長超過を拒否する", () => {
  assert.throws(
    () =>
      encodeMetricDescription({
        metricType: "gauge",
        valueRepresentation: "unsigned",
        name: null as unknown as string,
        unit: "",
      }),
    /metric name/,
  );
  assert.throws(
    () =>
      encodeMetricDescription({
        metricType: "gauge",
        valueRepresentation: "unsigned",
        name: "cpu",
        unit: null as unknown as string,
      }),
    /must be a string/,
  );
  // type 0 / representation 0 / name "a" / unit length 5（残り 0 バイト）
  assertMalformedObject(
    () => decodeMetricDescription(new Uint8Array([0x00, 0x00, 0x01, 0x61, 0x05])),
    /length/,
  );
});

test("MetricDescription: 切り詰めと長さ超過を拒否する", () => {
  assert.throws(() => decodeMetricDescription(new Uint8Array(0)), IncompleteDataError);
  // type 0 / representation 0 / name length 5（残り 0 バイト）
  assertMalformedObject(
    () => decodeMetricDescription(new Uint8Array([0x00, 0x00, 0x05])),
    /length/,
  );
  // type の vi64 が途中で切れている / value representation が無い
  assert.throws(() => decodeMetricDescription(new Uint8Array([0x80])), IncompleteDataError);
  assert.throws(() => decodeMetricDescription(new Uint8Array([0x00])), IncompleteDataError);
  // 空 Unit の固定ワイヤ + 末尾の将来拡張バイト
  const encoded = encodeMetricDescription({
    metricType: "gauge",
    valueRepresentation: "unsigned",
    name: "cpu",
    unit: "",
  });
  assert.deepEqual(encoded, new Uint8Array([0x00, 0x00, 0x03, 0x63, 0x70, 0x75, 0x00]));
  assert.deepEqual(decodeMetricDescription(new Uint8Array([...encoded, 0xff])), {
    metricType: "gauge",
    valueRepresentation: "unsigned",
    name: "cpu",
    unit: "",
  });
});

// [MOQMETRICS] §5.3: 同じ catalog version の Object N を複数の data track が参照できる。
test("Metric Index: track A / B が version 1 の同じ Index を参照し version 2 で維持・再割当する", () => {
  const version1 = metricsCatalogGroupId(1n);
  const cpu = decodeMetricDescription(
    encodeMetricDescription({
      metricType: "gauge",
      valueRepresentation: "unsigned",
      name: "cpu",
      unit: "%",
    }),
  );
  const memory = decodeMetricDescription(
    encodeMetricDescription({
      metricType: "gauge",
      valueRepresentation: "unsigned",
      name: "memory",
      unit: "bytes",
    }),
  );
  const catalogV1 = new Map<bigint, MetricDescription>([
    [metricObjectId(1n), cpu],
    [metricObjectId(2n), memory],
  ]);
  // track A も B も version 1 の同じ Index から同じ Description を独立に引く。
  const cpuBytes = encodeMetricDescription(cpu);
  const memoryBytes = encodeMetricDescription(memory);
  const trackA = new Map<bigint, MetricDescription>([
    [metricObjectId(1n), decodeMetricDescription(cpuBytes)],
    [metricObjectId(2n), decodeMetricDescription(memoryBytes)],
  ]);
  const trackB = new Map<bigint, MetricDescription>([
    [metricObjectId(1n), decodeMetricDescription(cpuBytes)],
    [metricObjectId(2n), decodeMetricDescription(memoryBytes)],
  ]);
  assert.equal(version1, 1n);
  assert.deepEqual(trackA.get(metricObjectId(1n)), trackB.get(metricObjectId(1n)));
  assert.equal(trackA.get(metricObjectId(1n))?.name, "cpu");
  assert.equal(trackB.get(metricObjectId(2n))?.name, "memory");

  // version 2 は Index 1 の cpu を維持し、Index 2 だけを memory から disk へ再割当する。
  const disk = decodeMetricDescription(
    encodeMetricDescription({
      metricType: "gauge",
      valueRepresentation: "unsigned",
      name: "disk",
      unit: "bytes",
    }),
  );
  const catalogV2 = new Map(catalogV1);
  catalogV2.set(metricObjectId(2n), disk);
  assert.equal(metricsCatalogGroupId(2n), 2n);
  assert.equal(catalogV2.get(metricObjectId(1n))?.name, "cpu");
  assert.equal(catalogV2.get(metricObjectId(2n))?.name, "disk");
  // version 1 の catalog は再割当の影響を受けない。
  assert.equal(catalogV1.get(metricObjectId(2n))?.name, "memory");
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

  // 未置換の template は §8.8 の literal でも escape でもない `%` を含むため parse できない。
  assert.throws(() => parseTrackNamespace(MOQMETRICS_NAMESPACE_TEMPLATE), /%/);

  // placeholder を含む 3 field tuple を直接 format すると `%` が `.25` になり、
  // resolveCatalogVariables の `%name%` として置換されない。
  const escaped = formatTrackNamespace(["metrics.moq.arpa", "v1", "%resourceId%"]);
  assert.equal(escaped, "metrics.2emoq.2earpa-v1-.25resourceId.25");
  const escapedCatalog: Catalog = {
    version: "draft-01",
    tracks: [],
    publishTracks: [
      {
        name: "4",
        namespace: escaped,
        packaging: "moqmetrics",
        role: "metrics",
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

// moq-metrics-03 §5.1: Track Name は granularity level の ASCII 数字 1 バイト。
// 0-7 の全値は moqmetrics.prop.ts の PBT が網羅するため、ここでは境界値とエラーパスを固定する。
test("metricsTrackName: 境界値は ASCII 数字 1 バイト、範囲外・非整数は throw", () => {
  assert.deepEqual(metricsTrackName(0), new TextEncoder().encode("0"));
  assert.deepEqual(metricsTrackName(7), new TextEncoder().encode("7"));
  assert.throws(() => metricsTrackName(-1), /0-7/);
  assert.throws(() => metricsTrackName(8), /0-7/);
  assert.throws(() => metricsTrackName(1.5), /0-7/);
  assert.throws(() => metricsTrackName(Number.NaN), /0-7/);
});

// moq-metrics-03 §5.1: catalog Track Name は ASCII の "catalog" で data track と別である。
test("metricsCatalogTrackName: ASCII の catalog を返す", () => {
  assert.deepEqual(metricsCatalogTrackName(), new TextEncoder().encode("catalog"));
  assert.equal(metricsCatalogTrackName().length, 7);
  assert.notDeepEqual(metricsCatalogTrackName(), metricsTrackName(4));
});

// 必須フィールド欠落・型誤りはデコード時に ProtocolViolationError になる。
test("MetricsCaptureObject: capture_timestamp 欠落・型誤りは throw", () => {
  assert.throws(
    () => decodeCaptureObject(encodeJson({})),
    ProtocolViolationError,
    /must be a finite number/,
  );
  assert.throws(
    () => decodeCaptureObject(encodeJson({ capture_timestamp: "1720367991" })),
    ProtocolViolationError,
    /must be a finite number/,
  );
  assert.throws(
    () => decodeCaptureObject(encodeJson({ capture_timestamp: null })),
    ProtocolViolationError,
    /must be a finite number/,
  );
});

test("MetricObject: value 欠落・型誤りは throw", () => {
  assert.throws(
    () => decodeMetricObject(encodeJson({})),
    ProtocolViolationError,
    /must be a finite number/,
  );
  assert.throws(
    () => decodeMetricObject(encodeJson({ metric_name: "cpu" })),
    ProtocolViolationError,
    /must be a finite number/,
  );
  assert.throws(
    () => decodeMetricObject(encodeJson({ value: "1" })),
    ProtocolViolationError,
    /must be a finite number/,
  );
  assert.throws(
    () => decodeMetricObject(encodeJson({ value: null })),
    ProtocolViolationError,
    /must be a finite number/,
  );
  assert.throws(
    () => decodeMetricObject(encodeJson({ value: true })),
    ProtocolViolationError,
    /must be a finite number/,
  );
  // metric_name 省略 (value のみ) は有効のままであること
  assert.deepEqual(decodeMetricObject(encodeJson({ value: 1 })), { value: 1 });
});

// 非有限数は null 化して送出されるため、エンコード時に失敗させる。
test("Metrics object: 非有限数 (NaN / 正負の Infinity) のエンコードは throw", () => {
  // 対象は既知数値フィールドのみ (capture_timestamp / value)。JSON.stringify は
  // 非有限数を null に落とすため、送出前に fail-fast する。
  for (const nonFinite of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.throws(() => encodeCaptureObject({ capture_timestamp: nonFinite }), /non-finite/);
    assert.throws(() => encodeMetricObject({ value: nonFinite }), /non-finite/);
  }
});

// JSON は NaN / Infinity をリテラルで表現できない。指数表記の範囲外 (1e999) は
// JSON.parse が Infinity を返すため、デコード側の有限数検査で拒否される。
test("Metrics payload: 指数表記の範囲外 (1e999 → Infinity) は throw", () => {
  assert.throws(
    () => decodeCaptureObject(new TextEncoder().encode('{"capture_timestamp":1e999}')),
    ProtocolViolationError,
    /must be a finite number/,
  );
  assert.throws(
    () => decodeMetricObject(new TextEncoder().encode('{"value":-1e999}')),
    ProtocolViolationError,
    /must be a finite number/,
  );
});

// NaN は JSON のリテラルではないため、payload 自体が不正な JSON として拒否される。
test("Metrics payload: NaN リテラルは不正な JSON として throw", () => {
  assert.throws(
    () => decodeCaptureObject(new TextEncoder().encode('{"capture_timestamp":NaN}')),
    ProtocolViolationError,
    /invalid moqmetrics capture object payload JSON/,
  );
  assert.throws(
    () => decodeMetricObject(new TextEncoder().encode('{"value":NaN}')),
    ProtocolViolationError,
    /invalid moqmetrics metric object payload JSON/,
  );
});

test("metricsTrackNamespace: 16 桁小文字 hexadecimal 以外の resourceId は throw", () => {
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
    assert.throws(() => metricsTrackNamespace(resourceId), /resourceId/);
  }
  assert.throws(() => metricsTrackNamespace(123 as unknown as string), /resourceId/);
});
