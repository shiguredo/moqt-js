/**
 * MOQMETRICS (Metrics track payload) Unit Tests
 * draft-jennings-moq-metrics-02 Section 3
 * draft-ietf-moq-msf-01 §10
 */

import { test, assert } from "vite-plus/test";
import {
  type MetricsCaptureObject,
  type MetricsValueObject,
  encodeMetricsCaptureObject,
  decodeMetricsCaptureObject,
  encodeMetricsValueObject,
  decodeMetricsValueObject,
  createMetricsGroupId,
  createMetricsObjectId,
  buildMetricsTrackNamespace,
  buildMetricsTrackName,
} from "./moqmetrics";

// ============================================================
// Object ID 0: capture timestamp + attributes
// ============================================================

// [MOQMETRICS] §3.1 の例をテストベクタとして使用する（構文誤りを修正済み）
test("MOQMETRICS: Object ID 0 の round-trip (capture timestamp + attributes)", () => {
  const obj: MetricsCaptureObject = {
    captureTimestamp: 1720367991000000000n,
    attributes: [{ location: "us-east-2" }, { os: "ubuntu20.4" }],
  };
  const encoded = encodeMetricsCaptureObject(obj);
  const decoded = decodeMetricsCaptureObject(encoded);
  assert.equal(decoded.captureTimestamp, 1720367991000000000n);
  assert.isDefined(decoded.attributes);
  assert.equal(decoded.attributes.length, 2);
  assert.equal(decoded.attributes[0].location, "us-east-2");
  assert.equal(decoded.attributes[1].os, "ubuntu20.4");
});

// attributes なしの Object ID 0
test("MOQMETRICS: Object ID 0 の round-trip (attributes なし)", () => {
  const obj: MetricsCaptureObject = {
    captureTimestamp: 1720369102000000000n,
  };
  const encoded = encodeMetricsCaptureObject(obj);
  const decoded = decodeMetricsCaptureObject(encoded);
  assert.equal(decoded.captureTimestamp, 1720369102000000000n);
  assert.isUndefined(decoded.attributes);
});

// number 型の capture_timestamp もデコードできる（後方互換）
test("MOQMETRICS: number 型の capture_timestamp をデコードできる", () => {
  const json = JSON.stringify({ capture_timestamp: 1720367991 });
  const data = new TextEncoder().encode(json);
  const decoded = decodeMetricsCaptureObject(data);
  assert.equal(decoded.captureTimestamp, 1720367991n);
});

// ============================================================
// Object ID 1 以降: metric name-value pair
// ============================================================

// [MOQMETRICS] §3.1 の例をテストベクタとして使用する（構文誤りを修正済み）
test("MOQMETRICS: Object ID 1 の round-trip (整数値)", () => {
  const obj: MetricsValueObject = {
    metricName: "cpu_usage_percentage",
    value: 99,
  };
  const encoded = encodeMetricsValueObject(obj);
  const decoded = decodeMetricsValueObject(encoded);
  assert.equal(decoded.metricName, "cpu_usage_percentage");
  assert.equal(decoded.value, 99);
});

test("MOQMETRICS: Object ID 2 の round-trip (浮動小数点値)", () => {
  const obj: MetricsValueObject = {
    metricName: "cpu_temperature",
    value: 45.1,
  };
  const encoded = encodeMetricsValueObject(obj);
  const decoded = decodeMetricsValueObject(encoded);
  assert.equal(decoded.metricName, "cpu_temperature");
  assert.equal(decoded.value, 45.1);
});

// metricName 省略時は undefined
test("MOQMETRICS: metricName 省略時は undefined になる", () => {
  const obj: MetricsValueObject = { value: 42 };
  const encoded = encodeMetricsValueObject(obj);
  const decoded = decodeMetricsValueObject(encoded);
  assert.isUndefined(decoded.metricName);
  assert.equal(decoded.value, 42);
});

// ============================================================
// Group ID / Object ID helper (msf-01 §10.3)
// ============================================================

// Group ID は Unix epoch ミリ秒を 62-bit に truncate する
test("MOQMETRICS: createMetricsGroupId は 62-bit に truncate する", () => {
  const timestamp = (1n << 62n) + 99999n;
  const groupId = createMetricsGroupId(timestamp);
  assert.equal(groupId, 99999n);
});

// 通常のタイムスタンプはそのまま通る
test("MOQMETRICS: createMetricsGroupId は 62-bit 以内の値をそのまま返す", () => {
  const timestamp = 1720367991000n;
  const groupId = createMetricsGroupId(timestamp);
  assert.equal(groupId, timestamp);
});

// Object ID はインデックスをそのまま返す
test("MOQMETRICS: createMetricsObjectId はインデックスを返す", () => {
  assert.equal(createMetricsObjectId(0), 0);
  assert.equal(createMetricsObjectId(1), 1);
  assert.equal(createMetricsObjectId(5), 5);
});

// ============================================================
// Namespace / Track Name helper
// ============================================================

test("MOQMETRICS: buildMetricsTrackNamespace は暫定形式を返す", () => {
  const ns = buildMetricsTrackNamespace("resource-1");
  assert.deepEqual(ns, ["moq://moq-metrics.arpa/metrics-v1/", "resource-1"]);
});

test("MOQMETRICS: buildMetricsTrackName は resourceID/granularity 形式を返す", () => {
  const name = buildMetricsTrackName("resource-1", 4);
  assert.equal(name, "resource-1/4");
});

test("MOQMETRICS: buildMetricsTrackName は 0-7 以外で throw する", () => {
  assert.throws(() => buildMetricsTrackName("r", -1), "metrics granularity level must be 0-7");
  assert.throws(() => buildMetricsTrackName("r", 8), "metrics granularity level must be 0-7");
});
