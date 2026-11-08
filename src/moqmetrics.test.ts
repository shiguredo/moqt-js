/**
 * MOQ Metrics (moqmetrics) の単体テスト
 * draft-jennings-moq-metrics-02 ([MOQMETRICS]) / draft-ietf-moq-msf-01 §10 (Metrics track)
 *
 * 任意の JSON object に対する round-trip は moqmetrics.prop.ts の PBT で検証する。
 * 本ファイルは §3.1 ベクタ・Object 0 / Object 1+ の構造・エラーパス・各 helper の固有挙動を扱う。
 */

import { test, assert } from "vite-plus/test";
import { ProtocolViolationError } from "./error";

import { encodeJson } from "./testSupport/helpers";
import { formatFullTrackName, formatTrackNamespace, parseTrackNamespace } from "./fullTrackName";
import { resolveCatalogVariables, type Catalog } from "./msf";
import {
  METRICS_CAPTURE_OBJECT_ID,
  MOQMETRICS_NAMESPACE_PREFIX,
  MOQMETRICS_NAMESPACE_TEMPLATE,
  encodeCaptureObject,
  decodeCaptureObject,
  encodeMetricObject,
  decodeMetricObject,
  metricsCatalogTrackName,
  metricsGroupId,
  metricObjectId,
  metricsTrackNamespace,
  metricsTrackName,
} from "./moqmetrics";

// Object ID 0（capture timestamp + attributes）と Object ID 1 以降（metric name-value pair）の
// round-trip は moqmetrics.prop.ts の PBT が任意の内容で検証する。
// [MOQMETRICS] §3.1 の Object 0 例をテストベクタとしてデコードできることを検証する。
test("MetricsCaptureObject: [MOQMETRICS] §3.1 の例を round-trip する", () => {
  const vector =
    '{"capture_timestamp":1720367991,"attributes":[{"location":"us-east-2"},{"os":"ubuntu20.4"}]}';
  const decoded = decodeCaptureObject(new TextEncoder().encode(vector));
  assert.equal(decoded.capture_timestamp, 1720367991);
  assert.deepEqual(decoded.attributes, [{ location: "us-east-2" }, { os: "ubuntu20.4" }]);

  const redecoded = decodeCaptureObject(encodeCaptureObject(decoded));
  assert.equal(redecoded.capture_timestamp, 1720367991);
});

// [MOQMETRICS] §3.1 の Object 1 / Object 2 例をテストベクタとして検証する。
// 注意: §3.1 の Object 1 例は L344 `value: 99` がキー引用符なしの構文誤り。修正版を使う。
test("MetricObject: [MOQMETRICS] §3.1 の例を round-trip する", () => {
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

// payload は JSON object でなければならない（[MOQMETRICS] §3）。
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

// msf-01 §10.3: Group ID は Unix epoch ミリ秒を 62-bit に truncate。
// 62-bit の境界値は PBT (moqmetrics.prop.ts) が確率的にしか踏まないため、ここで固定する。
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

// msf-01 §10.3: Object ID 0 は capture、Object ID 1 以降は metric。
test("metricObjectId: 0 始まりの metric 順序が Object ID 1 以降に対応する", () => {
  assert.equal(METRICS_CAPTURE_OBJECT_ID, 0n);
  assert.equal(metricObjectId(0), 1n);
  assert.equal(metricObjectId(1), 2n);
  assert.equal(metricObjectId(6), 7n);
});

test("metricObjectId: 負数・非整数は throw", () => {
  assert.throws(() => metricObjectId(-1), /non-negative integer/);
  assert.throws(() => metricObjectId(1.5), /non-negative integer/);
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
