/**
 * MOQT Message Parameter の PBT 用 arbitrary
 *
 * draft-ietf-moq-transport-21 Section 9.20
 *
 * `src/message/*.prop.ts` の各ファイルが同じ arbitrary を再定義していたため、
 * ここに集約する。このファイルは vitest の `test.include`
 * (`src/**\/*.{test,prop}.ts`) に一致しない名前にして、テストを含まない
 * ファイルがテストファイルとして収集されるのを避ける。
 *
 * テストを含む `parameter.prop.ts` を共有元にすると、それを import する
 * 各テストファイルの実行時にテストが重複登録されるため、この分離が必要。
 * ライブラリのビルド entry (`src/index.ts`) からも到達しない。
 */

import * as fc from "fast-check";
import {
  createTrackNamespace,
  encodeParameterTrackNamespace,
  encodeLocationFilterParameter,
  encodeRangeFilter,
  decodeRangeFilter,
  type LocationFilter,
} from "./parameter";
import { encodeVarint } from "../varint";
import { type Property, MOQTPropertyId, TrackPropertyId } from "../properties";

/**
 * Message Parameter の arbitrary
 *
 * draft-ietf-moq-transport-21 Section 9.20:
 * 各パラメータ型が独自の Value エンコーディングを定義する。
 */
export const varintParameterArb = fc
  .record({
    type: fc.constantFrom(0x02, 0x04, 0x06, 0x08, 0x32),
    varintValue: fc.bigInt({ min: 0n, max: 1000000n }),
  })
  .map(({ type, varintValue }) => ({ type, value: encodeVarint(varintValue) }));

// draft-ietf-moq-transport-21 §9.20.9 / §9.20.19: 値域制約に従う arbitrary
//   - FORWARD (0x10): 0 / 1
//   - SUBSCRIBER_PRIORITY (0x20): 0-255
//   - GROUP_ORDER (0x22): 0x1 / 0x2
export const uint8ParameterArb = fc.oneof(
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

export const locationParameterArb = fc
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

export const lengthPrefixedParameterArb = fc
  .record({
    type: fc.constant(0x03),
    value: fc.uint8Array({ minLength: 0, maxLength: 20 }),
  })
  .map(({ type, value }) => ({ type, value }));

/**
 * Track Namespace のフィールド列を生成する共通 arbitrary
 *
 * draft-ietf-moq-transport-21 §2.3:
 * "Each Track Namespace Field Value MUST contain at least one byte."
 * 各フィールドは 1 バイト以上必要なため minLength: 1 とする。
 *
 * メッセージの `trackNamespace` 用 (namespaceStringsArb) と
 * TRACK_NAMESPACE_PREFIX (0x34) パラメータの Value 用
 * (trackNamespaceParameterArb) で生成条件を共有する。
 */
export const namespacePartsArb = fc.array(fc.string({ minLength: 1, maxLength: 20 }), {
  minLength: 0,
  maxLength: 5,
});

/**
 * TRACK_NAMESPACE_PREFIX (0x34) パラメータの arbitrary
 *
 * draft-ietf-moq-transport-21 §9.20.21:
 * Value は §8.7 の Track Namespace エンコーディング (自己区切り)。
 * encodeParameterTrackNamespace の出力で構築する
 * (生バイト列の任意生成はフィールド数・Length の検証と衝突する)。
 */
export const trackNamespaceParameterArb = namespacePartsArb.map((parts) =>
  encodeParameterTrackNamespace(createTrackNamespace(parts)),
);

/**
 * LocationFilter の任意構築
 *
 * draft-ietf-moq-transport-21 §9.20.10: Length ベースの optional フィールド
 * (フィールド数 0〜4) の union。
 */
export const locationFilterArb: fc.Arbitrary<LocationFilter> = fc.oneof(
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
 * draft-ietf-moq-transport-21 §9.20.10: Value は「Length + optional vi64 フィールド」の
 * 1 Length 構造。encodeLocationFilter の出力 (内部 Length と整合したバイト列) で
 * 構築する (生バイト列の任意生成は内部 Length 検証と衝突する)。
 */
export const locationFilterParameterArb = locationFilterArb.map((filter) =>
  encodeLocationFilterParameter(filter),
);

/**
 * Range Filter の型とパラメータ種別の対応
 *
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
    for (const [i, delta] of deltas.entries()) {
      const start = current + delta;
      // 末尾以外は End を必ず付け、末尾は省略できる
      const end = i < deltas.length - 1 ? start + delta : undefined;
      if (end !== undefined) {
        ranges.push({ start, end });
      } else {
        ranges.push({ start });
      }
      current = end ?? start;
    }
    return ranges;
  });

export const rangeFilterParameterArb = fc
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
      // PRIORITY_FILTER は 255 以下の値のみ (§9.20.13)
      (filter.filterType !== "priority" ||
        ranges.every((r) => r.start <= 255n && (r.end === undefined || r.end <= 255n))),
  )
  .map(({ filter, setId, propertyType, ranges }) => {
    // exactOptionalPropertyTypes では optional な propertyType に undefined を渡せないため、
    // 値がある場合だけ載せる
    const spec =
      propertyType === undefined
        ? { type: filter.filterType, setId, ranges }
        : { type: filter.filterType, setId, propertyType, ranges };
    return {
      type: filter.type,
      value: encodeRangeFilter(spec),
    };
  });

/**
 * Message Parameter の union
 */
export const messageParameterArb = fc.oneof(
  varintParameterArb,
  uint8ParameterArb,
  locationParameterArb,
  lengthPrefixedParameterArb,
  trackNamespaceParameterArb,
  locationFilterParameterArb,
  rangeFilterParameterArb,
);

/**
 * Parameters リストの arbitrary
 *
 * delta encoding では type は昇順である必要があるため、生成後にソートする。
 * Range Filters は同型複数出現を許可する (SetID 違い) が、SetID が重複すると
 * decodeRangeFilter が失敗するため、重複する組み合わせは生成から除外する。
 */
export const parametersArb = fc
  .array(messageParameterArb, { minLength: 0, maxLength: 3 })
  .map((params) => {
    const sorted = [...params].sort((a, b) => a.type - b.type);
    // Range Filters は同型複数出現を許可する (SetID 違い)
    return sorted.filter((param, index) => {
      if (index === 0) return true;
      const previous = sorted[index - 1];
      if (previous === undefined) {
        // index >= 1 かつ sorted.length === params.length のため到達しない
        // (noUncheckedIndexedAccess で型上 undefined を含むための防御)
        return true;
      }
      if (param.type !== previous.type) return true;
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

// ============================================================================
// Track Property の arbitrary
// ============================================================================

// 値域制約のある Track Property は除外する (validateTrackPropertyValue で
// ProtocolViolationError になりラウンドトリップが成立しないため)
export const evenPropertyArb = fc
  .record({
    id: fc
      .bigInt({ min: 0n, max: 100n })
      .map((n) => n * 2n)
      .filter(
        (id) =>
          id !== TrackPropertyId.DEFAULT_PUBLISHER_PRIORITY &&
          id !== TrackPropertyId.DEFAULT_PUBLISHER_GROUP_ORDER &&
          id !== TrackPropertyId.DYNAMIC_GROUPS,
      ),
    value: fc.bigInt({ min: 0n, max: 1000000n }),
  })
  .map(({ id, value }) => ({ id, value }));

export const oddPropertyArb = fc
  .record({
    // IMMUTABLE_PROPERTIES (0x0b) は data に再帰的に IMMUTABLE_PROPERTIES を含むと
    // decodeProperties が MalformedTrackError を投げてラウンドトリップが成立しないため除外する
    id: fc
      .bigInt({ min: 0n, max: 100n })
      .map((n) => n * 2n + 1n)
      .filter((id) => id !== MOQTPropertyId.IMMUTABLE_PROPERTIES),
    data: fc.uint8Array({ minLength: 0, maxLength: 20 }),
  })
  .map(({ id, data }) => ({ id, data }));

export const propertyArb: fc.Arbitrary<Property> = fc.oneof(evenPropertyArb, oddPropertyArb);

export const trackPropertiesArb = fc.array(propertyArb, { minLength: 0, maxLength: 3 });

// ============================================================================
// メッセージ間で共有する名前系の arbitrary
// ============================================================================

export const namespaceStringsArb = namespacePartsArb;

export const trackNameArb = fc
  .string({ minLength: 1, maxLength: 50 })
  .map((s) => new TextEncoder().encode(s));

/**
 * Track Namespace の arbitrary
 *
 * フィールドは 1 バイト以上 (draft-ietf-moq-transport-21 §2.3) のため minLength: 1。
 */
export const namespaceArb = fc
  .array(fc.string({ minLength: 1, maxLength: 20 }), { minLength: 0, maxLength: 5 })
  .map((parts) => createTrackNamespace(parts));
