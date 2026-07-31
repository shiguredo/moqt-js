/**
 * MOQ Metrics (moqmetrics) の PBT テスト
 * draft-jennings-moq-metrics-02 ([MOQMETRICS]) / draft-ietf-moq-msf-01 §10 (Metrics track)
 */

import { test, assert } from "vite-plus/test";
import * as fc from "fast-check";
import {
  encodeCaptureObject,
  decodeCaptureObject,
  encodeMetricObject,
  decodeMetricObject,
  metricsGroupId,
  metricsTrackName,
  type MetricsCaptureObject,
  type MetricObject,
} from "./moqmetrics";

// Object ID 0（capture timestamp + optional attributes）の arbitrary。
// JSON round-trip で消える undefined 値のキーは持たせない（省略時はキーごと除外する）。
const captureObjectArb: fc.Arbitrary<MetricsCaptureObject> = fc
  .record({
    capture_timestamp: fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }),
    attributes: fc.option(
      fc.array(
        fc.dictionary(fc.string({ minLength: 1, maxLength: 8 }), fc.string(), { maxKeys: 2 }),
        {
          maxLength: 3,
        },
      ),
      { nil: undefined },
    ),
  })
  .map((raw) => {
    const obj: MetricsCaptureObject = { capture_timestamp: raw.capture_timestamp };
    if (raw.attributes !== undefined) {
      obj.attributes = raw.attributes;
    }
    return obj;
  });

// Object ID 1 以降（metric name-value pair）の arbitrary。value は float64 / int64。
// JSON round-trip で消える undefined 値のキーは持たせず、-0 は 0 に正規化する。
const metricObjectArb: fc.Arbitrary<MetricObject> = fc
  .record({
    metric_name: fc.option(fc.string({ minLength: 1, maxLength: 16 }), { nil: undefined }),
    value: fc.oneof(fc.integer(), fc.double({ noNaN: true, noDefaultInfinity: true })),
  })
  .map((raw) => {
    const obj: MetricObject = { value: Object.is(raw.value, -0) ? 0 : raw.value };
    if (raw.metric_name !== undefined) {
      obj.metric_name = raw.metric_name;
    }
    return obj;
  });

// [MOQMETRICS] §3: Object 0 payload は任意の capture object で round-trip が保持される。
test("MetricsCaptureObject round-trip: 内容が保持される", () => {
  fc.assert(
    fc.property(captureObjectArb, (obj) => {
      const decoded = decodeCaptureObject(encodeCaptureObject(obj));
      assert.deepEqual(decoded, obj);
    }),
  );
});

// [MOQMETRICS] §3: Object 1 以降 payload は任意の metric object で round-trip が保持される。
test("MetricObject round-trip: 内容が保持される", () => {
  fc.assert(
    fc.property(metricObjectArb, (obj) => {
      const decoded = decodeMetricObject(encodeMetricObject(obj));
      assert.deepEqual(decoded, obj);
    }),
  );
});

// msf-01 §10.3: Group ID は 62-bit 未満。非負 timestamp の truncate 結果は常に 0 以上 2^62 未満。
test("metricsGroupId: 非負 timestamp を 62-bit に truncate する", () => {
  fc.assert(
    fc.property(fc.bigInt({ min: 0n, max: (1n << 64n) - 1n }), (timestampMs) => {
      const groupId = metricsGroupId(timestampMs);
      // truncate 意味論: 下位 62-bit と一致する
      assert.equal(groupId, timestampMs & ((1n << 62n) - 1n));
      assert.isTrue(groupId >= 0n);
      assert.isTrue(groupId < 1n << 62n);
    }),
  );
});

// [MOQMETRICS] §3: Track Name は granularity level の 1 バイト（0=Emergency - 7=Debug）。
test("metricsTrackName: 0-7 の任意の level で 1 バイトを返す", () => {
  fc.assert(
    fc.property(fc.integer({ min: 0, max: 7 }), (level) => {
      const name = metricsTrackName(level);
      assert.equal(name.length, 1);
      assert.equal(name[0], level);
    }),
  );
});
