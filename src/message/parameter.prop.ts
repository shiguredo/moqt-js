/**
 * MOQT Parameter Property-Based Tests
 * draft-ietf-moq-transport-21 Section 9.20
 */

import { test, assert } from "vite-plus/test";
import * as fc from "fast-check";
import {
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
} from "./parameter";
import { locationFilterArb, parametersArb } from "./parameterArb";

test("TrackNamespace のエンコード・デコードがラウンドトリップする", () => {
  // draft-ietf-moq-transport-21 §2.3:
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
 * Parameters リストのエンコード・デコードがラウンドトリップする
 *
 * draft-ietf-moq-transport-21 Section 9.20:
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
 * draft-ietf-moq-transport-21 Section 3.3.2 (Range Filters):
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
