/**
 * MOQ Metrics (moqmetrics) の PBT テスト
 * draft-jennings-moq-metrics-03 ([MOQMETRICS]) / draft-ietf-moq-msf-01 §10 (Metrics track)
 *
 * catalog は metrics-03 §5.3、data Object は引き続き metrics-02 §3 の JSON 形式である。
 */

import { test, assert } from "vite-plus/test";
import * as fc from "fast-check";
import {
  encodeCaptureObject,
  decodeCaptureObject,
  encodeMetricObject,
  decodeMetricObject,
  encodeMetricsCatalogHeader,
  decodeMetricsCatalogHeader,
  encodeMetricDescription,
  decodeMetricDescription,
  metricsTrackName,
  type MetricsCaptureObject,
  type MetricObject,
  type MetricsCatalogHeader,
  type MetricDescription,
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

// catalog Header / Description の arbitrary。Name は ASCII の英数字・アンダースコア・コロン。
const utf8Arb = fc.string({ unit: "grapheme", maxLength: 16 });
const catalogAttributeArb = fc.record({ key: utf8Arb, value: utf8Arb });
const catalogHeaderArb: fc.Arbitrary<MetricsCatalogHeader> = fc.record({
  formatVersion: fc.constant(1n),
  attributes: fc.array(catalogAttributeArb, { maxLength: 8 }),
});
const metricNameArb = fc
  .array(
    fc.constantFrom(
      ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_:".split(""),
    ),
    { minLength: 1, maxLength: 16 },
  )
  .map((chars) => chars.join(""));
const descriptionArb: fc.Arbitrary<MetricDescription> = fc.record({
  metricType: fc.constantFrom("gauge" as const, "counter" as const),
  valueRepresentation: fc.constantFrom("unsigned" as const, "signed" as const, "float" as const),
  name: metricNameArb,
  unit: utf8Arb,
});

// 旧 metrics-02 §3: Object 0 payload は任意の capture object で round-trip が保持される。
test("MetricsCaptureObject round-trip: 内容が保持される", () => {
  fc.assert(
    fc.property(captureObjectArb, (obj) => {
      const decoded = decodeCaptureObject(encodeCaptureObject(obj));
      assert.deepEqual(decoded, obj);
    }),
  );
});

// 旧 metrics-02 §3: Object 1 以降 payload は任意の metric object で round-trip が保持される。
test("MetricObject round-trip: 内容が保持される", () => {
  fc.assert(
    fc.property(metricObjectArb, (obj) => {
      const decoded = decodeMetricObject(encodeMetricObject(obj));
      assert.deepEqual(decoded, obj);
    }),
  );
});

// [MOQMETRICS] §5.3: Catalog Header は任意の Attribute で round-trip が保持される。
test("MetricsCatalogHeader round-trip: 内容が保持される", () => {
  fc.assert(
    fc.property(catalogHeaderArb, (header) => {
      const decoded = decodeMetricsCatalogHeader(encodeMetricsCatalogHeader(header));
      assert.deepEqual(decoded, header);
    }),
  );
});

// [MOQMETRICS] §5.3: Metric Description は任意の有効な Name / Unit で round-trip が保持される。
test("MetricDescription round-trip: 内容が保持される", () => {
  fc.assert(
    fc.property(descriptionArb, (description) => {
      const decoded = decodeMetricDescription(encodeMetricDescription(description));
      assert.deepEqual(decoded, description);
    }),
  );
});

// moq-metrics-03 §5.1 / §5.2: Track Name は granularity level の ASCII 数字 1 バイト
// （0=Emergency - 7=Debug）。
test("metricsTrackName: 0-7 の任意の level で ASCII 数字 1 バイトを返す", () => {
  fc.assert(
    fc.property(fc.integer({ min: 0, max: 7 }), (level) => {
      const name = metricsTrackName(level);
      assert.equal(name.length, 1);
      assert.equal(name[0], new TextEncoder().encode(String(level))[0]);
    }),
  );
});
