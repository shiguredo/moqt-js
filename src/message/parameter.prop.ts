/**
 * MOQT Parameter Property-Based Tests
 * draft-ietf-moq-transport-19 Section 10.2
 */

import { test, assert } from "vite-plus/test";
import * as fc from "fast-check";
import {
  encodeParameter,
  decodeParameter,
  encodeTrackNamespace,
  decodeTrackNamespace,
  createTrackNamespace,
  trackNamespaceToStrings,
  encodeLocation,
  decodeLocation,
  encodeParameters,
  decodeParameters,
  encodeLocationFilter,
  decodeLocationFilter,
  encodeLocationFilterParameter,
  decodeLocationFilterParameter,
  encodeRangeFilter,
  decodeRangeFilter,
  getParameterVarintValue,
  type LocationFilter,
} from "./parameter";
import { encodeVarint } from "../varint";

test("偶数タイプの Parameter のエンコード・デコードがラウンドトリップする", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 0, max: 100 }).map((n) => n * 2),
      fc.bigInt({ min: 0n, max: 1000000n }),
      (type, varintValue) => {
        const value = encodeVarint(varintValue);
        const param = { type, value };
        const encoded = encodeParameter(param);
        const [decoded, consumed] = decodeParameter(encoded);

        assert.equal(decoded.type, type);
        assert.equal(getParameterVarintValue(decoded), varintValue);
        assert.equal(consumed, encoded.length);
      },
    ),
  );
});

test("奇数タイプの Parameter のエンコード・デコードがラウンドトリップする", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 0, max: 100 }).map((n) => n * 2 + 1),
      fc.uint8Array({ minLength: 0, maxLength: 100 }),
      (type, value) => {
        const param = { type, value };
        const encoded = encodeParameter(param);
        const [decoded, consumed] = decodeParameter(encoded);

        assert.equal(decoded.type, type);
        assert.deepEqual(decoded.value, value);
        assert.equal(consumed, encoded.length);
      },
    ),
  );
});

test("TrackNamespace のエンコード・デコードがラウンドトリップする", () => {
  // draft-ietf-moq-transport-19 §2.3:
  // "Each Track Namespace Field Value MUST contain at least one byte."
  // 各フィールドは 1 バイト以上必要なため minLength: 1 とする
  fc.assert(
    fc.property(
      fc.array(fc.string({ minLength: 1, maxLength: 30 }), { minLength: 0, maxLength: 10 }),
      (parts) => {
        const ns = createTrackNamespace(parts);
        const encoded = encodeTrackNamespace(ns);
        const [decoded, consumed] = decodeTrackNamespace(encoded);
        const result = trackNamespaceToStrings(decoded);

        assert.deepEqual(result, parts);
        assert.equal(consumed, encoded.length);
      },
    ),
  );
});

test("Location のエンコード・デコードがラウンドトリップする", () => {
  fc.assert(
    fc.property(
      fc.bigInt({ min: 0n, max: 10000000n }),
      fc.bigInt({ min: 0n, max: 10000000n }),
      (group, object) => {
        const location = { group, object };
        const encoded = encodeLocation(location);
        const [decoded, consumed] = decodeLocation(encoded);

        assert.equal(decoded.group, group);
        assert.equal(decoded.object, object);
        assert.equal(consumed, encoded.length);
      },
    ),
  );
});

/**
 * Message Parameter の arbitrary
 *
 * draft-ietf-moq-transport-19 Section 10.2:
 * 各パラメータ型が独自の Value エンコーディングを定義する。
 * - varint: 0x02, 0x04, 0x06, 0x08, 0x32
 * - uint8: 0x10, 0x20, 0x22
 * - location: 0x09
 * - length-prefixed: 0x03, 0x21, 0x34
 */
const varintParameterArb = fc
  .record({
    type: fc.constantFrom(0x02, 0x04, 0x06, 0x08, 0x32),
    varintValue: fc.bigInt({ min: 0n, max: 1000000n }),
  })
  .map(({ type, varintValue }) => ({ type, value: encodeVarint(varintValue) }));

// draft-ietf-moq-transport-19 §10.2.8 / §10.2.17: 値域制約に従う arbitrary
//   - FORWARD (0x10): 0 / 1
//   - SUBSCRIBER_PRIORITY (0x20): 0-255
//   - GROUP_ORDER (0x22): 0x1 / 0x2
const uint8ParameterArb = fc.oneof(
  fc
    .record({ type: fc.constant(0x10), byteValue: fc.constantFrom(0, 1) })
    .map(({ type, byteValue }) => ({ type, value: new Uint8Array([byteValue]) })),
  fc
    .record({ type: fc.constant(0x20), byteValue: fc.integer({ min: 0, max: 255 }) })
    .map(({ type, byteValue }) => ({ type, value: new Uint8Array([byteValue]) })),
  fc
    .record({ type: fc.constant(0x22), byteValue: fc.constantFrom(1, 2) })
    .map(({ type, byteValue }) => ({ type, value: new Uint8Array([byteValue]) })),
);

const locationParameterArb = fc
  .record({
    group: fc.bigInt({ min: 0n, max: 1000000n }),
    object: fc.bigInt({ min: 0n, max: 1000000n }),
  })
  .map(({ group, object }) => {
    const groupBytes = encodeVarint(group);
    const objectBytes = encodeVarint(object);
    const value = new Uint8Array(groupBytes.length + objectBytes.length);
    value.set(groupBytes, 0);
    value.set(objectBytes, groupBytes.length);
    return { type: 0x09, value };
  });

const lengthPrefixedParameterArb = fc
  .record({
    type: fc.constantFrom(0x03, 0x34),
    value: fc.uint8Array({ minLength: 0, maxLength: 20 }),
  })
  .map(({ type, value }) => ({ type, value }));

/**
 * LocationFilter の任意構築
 *
 * draft-ietf-moq-transport-20 §5.1.2: Length ベースの optional フィールド
 * (フィールド数 0〜4) の union。
 */
const locationFilterArb: fc.Arbitrary<LocationFilter> = fc.oneof(
  fc.constant({ reset: true } as const),
  fc.bigInt({ min: 0n, max: 1000000n }).map((startGroup) => ({ startGroup })),
  fc.record({
    startGroup: fc.bigInt({ min: 0n, max: 1000000n }),
    startObject: fc.bigInt({ min: 0n, max: 1000000n }),
  }),
  fc.record({
    startGroup: fc.bigInt({ min: 0n, max: 1000000n }),
    startObject: fc.bigInt({ min: 0n, max: 1000000n }),
    endGroupDelta: fc.bigInt({ min: 0n, max: 1000000n }),
  }),
  fc.record({
    startGroup: fc.bigInt({ min: 0n, max: 1000000n }),
    startObject: fc.bigInt({ min: 0n, max: 1000000n }),
    endGroupDelta: fc.bigInt({ min: 0n, max: 1000000n }),
    endObject: fc.bigInt({ min: 0n, max: 1000000n }),
  }),
);

/**
 * LOCATION_FILTER (0x21) パラメータの arbitrary
 *
 * draft-ietf-moq-transport-20 §5.1.2: Value は「Length + optional vi64 フィールド」の
 * 1 Length 構造。encodeLocationFilter の出力 (内部 Length と整合したバイト列) で
 * 構築する (生バイト列の任意生成は内部 Length 検証と衝突する)。
 * Range Filter と同様の生成方針 (rangeFilterParameterArb を参照)。
 */
const locationFilterParameterArb = locationFilterArb.map((filter) =>
  encodeLocationFilterParameter(filter),
);

/**
 * Range Filter パラメータ (0x25-0x29) の arbitrary
 *
 * draft-ietf-moq-transport-19 Section 5.1.3:
 * Range Filter の Value は「Length + [SetID + [Property Type] + Range 列]」の
 * 1 Length 構造。encodeRangeFilter の出力 (内部 Length と整合したバイト列) で
 * 構築する (生バイト列の任意生成は内部 Length 検証と衝突する)。
 * 同型複数出現 (複数 SetID) のケースを含めるため、型ごとの重複除去はしない。
 */
const RANGE_FILTER_TYPE_TO_PARAM: Array<{
  type: number;
  filterType: "subgroup" | "objectId" | "priority" | "objectProperty" | "trackProperty";
}> = [
  { type: 0x25, filterType: "subgroup" },
  { type: 0x26, filterType: "objectId" },
  { type: 0x27, filterType: "priority" },
  { type: 0x28, filterType: "objectProperty" },
  { type: 0x29, filterType: "trackProperty" },
];

// 単調増加する ranges を生成する arbitrary (各 start >= 前 end)
const rangeFilterRangesArb = fc
  .array(fc.bigInt({ min: 0n, max: 100n }), { minLength: 1, maxLength: 3 })
  .map((deltas) => {
    let current = 0n;
    const ranges: Array<{ start: bigint; end?: bigint }> = [];
    for (let i = 0; i < deltas.length; i++) {
      const start = current + deltas[i];
      // 末尾以外は End を必ず付け、末尾は省略できる
      const end = i < deltas.length - 1 ? start + deltas[i] : undefined;
      if (end !== undefined) {
        ranges.push({ start, end });
      } else {
        ranges.push({ start });
      }
      current = end ?? start;
    }
    return ranges;
  });

const rangeFilterParameterArb = fc
  .record({
    filter: fc.constantFrom(...RANGE_FILTER_TYPE_TO_PARAM),
    setId: fc.integer({ min: 0, max: 255 }),
    propertyType: fc.option(
      fc.bigInt({ min: 0n, max: 1000n }).map((n) => n * 2n),
      {
        nil: undefined,
      },
    ),
    ranges: rangeFilterRangesArb,
  })
  .filter(
    ({ filter, propertyType, ranges }) =>
      // OBJECT_PROPERTY_FILTER / TRACK_PROPERTY_FILTER は propertyType 必須
      ((filter.filterType !== "objectProperty" && filter.filterType !== "trackProperty") ||
        propertyType !== undefined) &&
      // PRIORITY_FILTER は 255 以下の値のみ (§10.2.12)
      (filter.filterType !== "priority" ||
        ranges.every((r) => r.start <= 255n && (r.end === undefined || r.end <= 255n))),
  )
  .map(({ filter, setId, propertyType, ranges }) => {
    return {
      type: filter.type,
      value: encodeRangeFilter({
        type: filter.filterType,
        setId,
        propertyType,
        ranges,
      }),
    };
  });

const messageParameterArb = fc.oneof(
  varintParameterArb,
  uint8ParameterArb,
  locationParameterArb,
  lengthPrefixedParameterArb,
  locationFilterParameterArb,
  rangeFilterParameterArb,
);

/**
 * Message Parameters リストの arbitrary
 *
 * draft-ietf-moq-transport-19 Section 10.2:
 * パラメータは Type の昇順でソートされ、各 Type は一意である必要がある。
 * ただし Range Filters (0x25-0x29) は複数回出現が許可される (isRepeatable と同じ扱い)。
 * 同型の Range Filter が複数出現する場合、同一 SetID の重複は仕様違反
 * (draft-ietf-moq-transport-19 §5.1.3 の INVALID_FILTER MUST) のため、
 * SetID が重複するケースを生成から除外する。
 */
const parametersArb = fc
  .array(messageParameterArb, { minLength: 0, maxLength: 3 })
  .map((params) => {
    const sorted = [...params].sort((a, b) => a.type - b.type);
    // Range Filters は同型複数出現を許可する (SetID 違い)
    return sorted.filter((param, index) => {
      if (index === 0) return true;
      if (param.type !== sorted[index - 1].type) return true;
      return param.type >= 0x25 && param.type <= 0x29;
    });
  })
  .filter((params) => {
    // 同型の Range Filter 間で SetID が重複しないことを保証する。
    // decodeRangeFilter で SetID を読み取り、重複があれば生成を除外する
    // (Length=0 の削除エントリは SetID を持たないため対象外)。
    const seenSetIds = new Map<number, Set<number>>();
    for (const param of params) {
      if (param.type < 0x25 || param.type > 0x29) continue;
      const filterType = RANGE_FILTER_TYPE_TO_PARAM.find((f) => f.type === param.type);
      if (filterType === undefined) continue;
      const [decoded] = decodeRangeFilter(filterType.filterType, param.value);
      if ("remove" in decoded && decoded.remove) continue;
      const setIds = seenSetIds.get(param.type) ?? new Set<number>();
      if ("setId" in decoded && setIds.has(decoded.setId)) {
        return false;
      }
      if ("setId" in decoded) {
        setIds.add(decoded.setId);
        seenSetIds.set(param.type, setIds);
      }
    }
    return true;
  });

/**
 * Parameters リストのエンコード・デコードがラウンドトリップする
 *
 * draft-ietf-moq-transport-19 Section 10.2:
 * delta encoding を使用するため、type は昇順である必要がある。
 * テストでは生成されたパラメータを type でソートしてから使用する。
 */
test("Parameters リストのエンコード・デコードがラウンドトリップする", () => {
  fc.assert(
    fc.property(parametersArb, (params) => {
      const encoded = encodeParameters(params);
      const [decoded, consumed] = decodeParameters(encoded);

      assert.equal(decoded.length, params.length);
      for (let i = 0; i < params.length; i++) {
        assert.equal(decoded[i].type, params[i].type);
        assert.deepEqual(decoded[i].value, params[i].value);
      }
      assert.equal(consumed, encoded.length);
    }),
  );
});

test("LocationFilter のエンコード・デコードがラウンドトリップする", () => {
  fc.assert(
    fc.property(locationFilterArb, (filter) => {
      const encoded = encodeLocationFilter(filter);
      const [decoded, consumed] = decodeLocationFilter(encoded);

      assert.deepEqual(decoded, filter);
      assert.equal(consumed, encoded.length);
    }),
  );
});

test("LocationFilter パラメータのエンコード・デコードがラウンドトリップする", () => {
  fc.assert(
    fc.property(locationFilterArb, (filter) => {
      const param = encodeLocationFilterParameter(filter);
      assert.equal(param.type, 0x21);

      const decoded = decodeLocationFilterParameter(param);
      assert.deepEqual(decoded, filter);
    }),
  );
});

/**
 * draft-ietf-moq-transport-19 Section 5.1.3 (Range Filters):
 * Range Filter の encode/decode がラウンドトリップすることを検証する。
 * delta エンコーディング（例: ranges 3–5 と 10–15 → Start=3, End=2, Start=5, End=5）。
 */
test("RangeFilter のエンコード・デコードがラウンドトリップする", () => {
  fc.assert(
    fc.property(
      fc.constantFrom("subgroup", "objectId", "priority") as fc.Arbitrary<
        "subgroup" | "objectId" | "priority"
      >,
      fc.integer({ min: 0, max: 255 }),
      // 単調増加する ranges を生成（各 start >= 前 end）
      fc
        .array(fc.bigInt({ min: 0n, max: 100n }), { minLength: 1, maxLength: 3 })
        .chain((deltas) => {
          // deltas から単調増加する ranges を構築
          let current = 0n;
          const ranges: Array<{ start: bigint; end: bigint }> = [];
          for (const d of deltas) {
            const start = current + d;
            const end = start + d; // end >= start を保証
            ranges.push({ start, end });
            current = end;
          }
          return fc.constant({ type: "subgroup" as const, setId: 0, ranges });
        }),
      (_type, setId, spec) => {
        const finalSpec = { ...spec, setId };
        const encoded = encodeRangeFilter(finalSpec);
        const [decoded, consumed] = decodeRangeFilter(finalSpec.type, encoded);

        assert.equal(consumed, encoded.length);
        assert.isFalse("remove" in decoded && decoded.remove);
        if (!("remove" in decoded)) {
          assert.equal(decoded.setId, setId);
          assert.equal(decoded.ranges.length, finalSpec.ranges.length);
          for (let i = 0; i < finalSpec.ranges.length; i++) {
            assert.equal(decoded.ranges[i].start, finalSpec.ranges[i].start);
            assert.equal(decoded.ranges[i].end, finalSpec.ranges[i].end);
          }
        }
      },
    ),
  );
});

/**
 * Range Filter の Length=0（削除）がラウンドトリップすることを検証する。
 */
test("RangeFilter の削除（Length=0）がラウンドトリップする", () => {
  fc.assert(
    fc.property(
      fc.constantFrom(
        "subgroup",
        "objectId",
        "priority",
        "objectProperty",
        "trackProperty",
      ) as fc.Arbitrary<"subgroup" | "objectId" | "priority" | "objectProperty" | "trackProperty">,
      (type) => {
        const spec = { type, remove: true as const };
        const encoded = encodeRangeFilter(spec);
        const [decoded, consumed] = decodeRangeFilter(type, encoded);

        assert.equal(consumed, encoded.length);
        assert.isTrue("remove" in decoded && decoded.remove);
      },
    ),
  );
});
