/**
 * MOQ Metrics (moqmetrics) の PBT テスト
 * draft-jennings-moq-metrics-03 ([MOQMETRICS]) / draft-ietf-moq-msf-01 §10 (Metrics track)
 *
 * catalog は metrics-03 §5.3、data Object は §5.4 のバイナリ Capture Info / Metric Value。
 */

import { test, assert } from "vite-plus/test";
import * as fc from "fast-check";
import {
  decodeMetricDescription,
  decodeMetricValue,
  decodeMetricsCaptureInfo,
  decodeMetricsCatalogHeader,
  encodeMetricDescription,
  encodeMetricValue,
  encodeMetricsCaptureInfo,
  encodeMetricsCatalogHeader,
  metricsTrackName,
  type MetricDescription,
  type MetricsCaptureInfo,
  type MetricsCatalogHeader,
} from "./moqmetrics";
import { MAX_VARINT } from "./varint";

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

// Capture Info / Metric Value の arbitrary。
const captureInfoArb: fc.Arbitrary<MetricsCaptureInfo> = fc.record({
  timestampOffset: fc.bigInt({ min: 0n, max: 999999n }),
  catalogVersion: fc.bigInt({ min: 1n, max: MAX_VARINT }),
});

const unsignedValueArb = fc.bigInt({ min: 0n, max: MAX_VARINT });
const signedValueArb = fc.bigInt({ min: -(1n << 63n), max: (1n << 63n) - 1n });
const floatValueArb = fc.double();

// [MOQMETRICS] §5.4: Capture Info は任意の値域内の値で round-trip が保持される。
test("MetricsCaptureInfo round-trip: 内容が保持される", () => {
  fc.assert(
    fc.property(captureInfoArb, (info) => {
      assert.deepEqual(decodeMetricsCaptureInfo(encodeMetricsCaptureInfo(info)), info);
    }),
  );
});

// [MOQMETRICS] §5.4: unsigned の任意の vi64 で round-trip が保持される。
test("MetricValue unsigned round-trip: 内容が保持される", () => {
  fc.assert(
    fc.property(unsignedValueArb, (value) => {
      const description: MetricDescription = {
        metricType: "counter",
        valueRepresentation: "unsigned",
        name: "m",
        unit: "",
      };
      assert.equal(decodeMetricValue(description, encodeMetricValue(description, value)), value);
    }),
  );
});

// [MOQMETRICS] §5.4: signed の任意の 64-bit 整数で round-trip が保持される。
test("MetricValue signed round-trip: 内容が保持される", () => {
  fc.assert(
    fc.property(signedValueArb, (value) => {
      const description: MetricDescription = {
        metricType: "gauge",
        valueRepresentation: "signed",
        name: "m",
        unit: "",
      };
      assert.equal(decodeMetricValue(description, encodeMetricValue(description, value)), value);
    }),
  );
});

// [MOQMETRICS] §5.4: float は NaN / -0 を含む binary64 をそのまま保持する。
test("MetricValue float round-trip: 内容が保持される", () => {
  fc.assert(
    fc.property(floatValueArb, (value) => {
      const description: MetricDescription = {
        metricType: "gauge",
        valueRepresentation: "float",
        name: "m",
        unit: "",
      };
      const decoded = decodeMetricValue(description, encodeMetricValue(description, value));
      assert.isTrue(Object.is(decoded, value));
    }),
  );
});

// [MOQMETRICS] §5.3: Catalog Header は任意の Attribute で round-trip が保持される。
test("MetricsCatalogHeader round-trip: 内容が保持される", () => {
  fc.assert(
    fc.property(catalogHeaderArb, (header) => {
      assert.deepEqual(decodeMetricsCatalogHeader(encodeMetricsCatalogHeader(header)), header);
    }),
  );
});

// [MOQMETRICS] §5.3: Metric Description は任意の有効な Name / Unit で round-trip が保持される。
test("MetricDescription round-trip: 内容が保持される", () => {
  fc.assert(
    fc.property(descriptionArb, (description) => {
      assert.deepEqual(decodeMetricDescription(encodeMetricDescription(description)), description);
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
