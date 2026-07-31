/**
 * MOQ Metrics (moqmetrics) の単体テスト
 * draft-jennings-moq-metrics-02 ([MOQMETRICS]) / draft-ietf-moq-msf-01 §10 (Metrics track)
 *
 * 任意の JSON object に対する round-trip は moqmetrics.prop.ts の PBT で検証する。
 * 本ファイルは §3.1 ベクタ・Object 0 / Object 1+ の構造・エラーパス・各 helper の固有挙動を扱う。
 */

import { test, assert } from "vite-plus/test";
import {
  METRICS_GRANULARITY_LEVELS,
  METRICS_CAPTURE_OBJECT_ID,
  MOQMETRICS_NAMESPACE_PREFIX,
  encodeCaptureObject,
  decodeCaptureObject,
  encodeMetricObject,
  decodeMetricObject,
  metricsGroupId,
  metricObjectId,
  metricsTrackNamespace,
  metricsTrackName,
  type MetricsCaptureObject,
  type MetricObject,
} from "./moqmetrics";

// Object ID 0（capture timestamp + attributes）の round-trip。
// 注意: capture_timestamp は Unix epoch ナノ秒だが、JSON number は Number.MAX_SAFE_INTEGER
// を超えると精度を失う。[MOQMETRICS] §3.1 の例も安全な整数（1720367991）を使う。
test("MetricsCaptureObject: round-trip", () => {
  const obj: MetricsCaptureObject = {
    capture_timestamp: 1720367991000000,
    attributes: [{ location: "us-east-2" }, { os: "ubuntu20.4" }],
  };
  const decoded = decodeCaptureObject(encodeCaptureObject(obj));
  assert.equal(decoded.capture_timestamp, 1720367991000000);
  assert.deepEqual(decoded.attributes, [{ location: "us-east-2" }, { os: "ubuntu20.4" }]);
});

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

// Object ID 1 以降（metric name-value pair）の round-trip。
test("MetricObject: round-trip", () => {
  const obj: MetricObject = { metric_name: "cpu_usage_percentage", value: 99 };
  const decoded = decodeMetricObject(encodeMetricObject(obj));
  assert.equal(decoded.metric_name, "cpu_usage_percentage");
  assert.equal(decoded.value, 99);
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

// granularity level の文字列 ↔ 優先度（0-7）の対応（msf-01 §10.2、syslog と同一）。
test("METRICS_GRANULARITY_LEVELS: syslog severity と同一の対応", () => {
  assert.equal(METRICS_GRANULARITY_LEVELS.Emergency, 0);
  assert.equal(METRICS_GRANULARITY_LEVELS.Informational, 6);
  assert.equal(METRICS_GRANULARITY_LEVELS.Debug, 7);
});

// msf-01 §10.3: Group ID は Unix epoch ミリ秒を 62-bit に truncate。
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

// [MOQMETRICS] §3 / msf-01 §10.2（暫定）: Track Namespace は 2 タプル。
test("metricsTrackNamespace: prefix と resourceID の 2 タプル", () => {
  assert.deepEqual(metricsTrackNamespace("res-1"), [MOQMETRICS_NAMESPACE_PREFIX, "res-1"]);
  assert.equal(MOQMETRICS_NAMESPACE_PREFIX, "moq://metrics.moq.arpa/v1/");
});

// [MOQMETRICS] §3 / msf-01 §10.2（暫定）: Track Name は granularity level の 1 バイト。
test("metricsTrackName: granularity level の 1 バイトを返す", () => {
  assert.deepEqual(Array.from(metricsTrackName(0)), [0]);
  assert.deepEqual(Array.from(metricsTrackName(4)), [4]);
  assert.deepEqual(Array.from(metricsTrackName(7)), [7]);
});

test("metricsTrackName: 0-7 の範囲外・非整数は throw", () => {
  assert.throws(() => metricsTrackName(-1), /0-7/);
  assert.throws(() => metricsTrackName(8), /0-7/);
  assert.throws(() => metricsTrackName(1.5), /0-7/);
  assert.throws(() => metricsTrackName(Number.NaN), /0-7/);
});
