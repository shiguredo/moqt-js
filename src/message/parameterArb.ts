/**
 * MOQT Message Parameter の PBT 用 arbitrary
 *
 * draft-ietf-moq-transport-23 Section 9.19 (Control Message Parameters)
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
  type Parameter,
} from "./parameter";
import { encodeVarint } from "../varint";
import {
  type Property,
  MOQTPropertyId,
  TrackPropertyId,
  findDuplicateSupportedProperty,
  getPropertyScope,
  isPropertyScopeAllowed,
} from "../properties";

/**
 * Message Parameter の arbitrary
 *
 * draft-ietf-moq-transport-22 Section 9.20:
 * 各パラメータ型が独自の Value エンコーディングを定義する。
 */
export const varintParameterArb = fc
  .record({
    type: fc.constantFrom(0x02, 0x04, 0x06, 0x08, 0x32),
    varintValue: fc.bigInt({ min: 0n, max: 1000000n }),
  })
  .map(({ type, varintValue }) => ({ type, value: encodeVarint(varintValue) }));

// draft-ietf-moq-transport-23 §9.19.7 / §9.19.8 / §9.19.18: 値域制約に従う arbitrary
//   - PAUSED (0x11): 0 (unpaused) / 1 (paused)
//   - SUBSCRIBER_PRIORITY (0x20): 0-255
//   - GROUP_ORDER (0x22): 0x1 / 0x2
export const uint8ParameterArb = fc.oneof(
  fc
    .record({ type: fc.constant(0x11), byteValue: fc.constantFrom(0, 1) })
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
 * draft-ietf-moq-transport-22 §2.3:
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
 * draft-ietf-moq-transport-22 §9.20.20:
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
 * draft-ietf-moq-transport-22 §9.20.9: Location Filter Type 0x00〜0x05 の union。
 * 0x05 (Next Object) はフィールドを持たない。
 */
export const locationFilterArb: fc.Arbitrary<LocationFilter> = fc.oneof(
  fc.constant({ reset: true } as const),
  fc.constant({ nextObject: true } as const),
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
 * draft-ietf-moq-transport-22 §9.20.9: Value は Location Filter Type (vi64) と
 * 型ごとの vi64 フィールドで自己区切りになる。encodeLocationFilter の出力
 * (Type とフィールドが整合したバイト列) で構築する。
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
      // PRIORITY_FILTER は 255 以下の値のみ (§9.20.12)
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

/**
 * FILL_PARAMETERS の内側 Parameters 列の arbitrary
 *
 * draft-ietf-moq-transport-23 §9.19.15 Table 7:
 * 内側に載せられるのは FILL_TIMEOUT (0x0A) / SUBSCRIBER_PRIORITY (0x20) /
 * LOCATION_FILTER (0x21) / GROUP_ORDER (0x22) / Range Filters (0x25-0x28) のみ。
 * 異常系 (一覧外の型・入れ子・切り詰め) は単体テストが担うため、
 * ここでは Round-trip 用に各種類を高々 1 件ずつ生成する。Range Filter は
 * §3.3.2 が複数回の出現を許すため、異なる型を最大 2 件生成する
 * (TRACK_PROPERTY_FILTER 0x29 は SUBSCRIBE_TRACKS 専用のため生成しない)。
 */
export const fillParametersArb: fc.Arbitrary<Parameter[]> = fc
  .record({
    fillTimeout: fc.option(fc.bigInt({ min: 0n, max: 1000000n }), { nil: undefined }),
    subscriberPriority: fc.option(fc.integer({ min: 0, max: 255 }), { nil: undefined }),
    locationFilter: fc.option(locationFilterArb, { nil: undefined }),
    groupOrder: fc.option(fc.constantFrom(0x01, 0x02), { nil: undefined }),
    rangeFilters: fc.uniqueArray(
      rangeFilterParameterArb.filter((parameter) => parameter.type !== 0x29),
      { maxLength: 2, selector: (parameter) => parameter.type },
    ),
  })
  .map(({ fillTimeout, subscriberPriority, locationFilter, groupOrder, rangeFilters }) => {
    const parameters: Parameter[] = [];
    if (fillTimeout !== undefined) {
      parameters.push({ type: 0x0a, value: encodeVarint(fillTimeout) });
    }
    if (subscriberPriority !== undefined) {
      parameters.push({ type: 0x20, value: new Uint8Array([subscriberPriority]) });
    }
    if (locationFilter !== undefined) {
      parameters.push(encodeLocationFilterParameter(locationFilter));
    }
    if (groupOrder !== undefined) {
      parameters.push({ type: 0x22, value: new Uint8Array([groupOrder]) });
    }
    for (const rangeFilter of rangeFilters) {
      parameters.push(rangeFilter);
    }
    return parameters;
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

export const trackPropertiesArb = fc
  .array(propertyArb, { minLength: 0, maxLength: 3 })
  .filter(
    (properties) =>
      findDuplicateSupportedProperty(properties, new Map<bigint, number>(), true) === undefined,
  );

/**
 * Track Properties として合法な Property の arbitrary
 *
 * draft-ietf-moq-transport-23 §8.4:
 * 対応済み Property を scope 外 (Track-only を Object として等) で受信すると Track が
 * malformed になる。PUBLISH / SUBSCRIBE_OK などの Track Properties を round-trip
 * する PBT では、Track scope を持たない既知 Property を生成しない。
 * 未知 Property は scope を知らないため許可する。
 */
export const trackScopePropertiesArb = fc
  .array(
    propertyArb.filter((property) => {
      const scope = getPropertyScope(property.id);
      return scope === undefined || isPropertyScopeAllowed(scope, "track");
    }),
    { minLength: 0, maxLength: 3 },
  )
  .filter(
    (properties) =>
      findDuplicateSupportedProperty(properties, new Map<bigint, number>(), true) === undefined,
  );

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
 * フィールドは 1 バイト以上 (draft-ietf-moq-transport-22 §2.3) のため minLength: 1。
 */
export const namespaceArb = fc
  .array(fc.string({ minLength: 1, maxLength: 20 }), { minLength: 0, maxLength: 5 })
  .map((parts) => createTrackNamespace(parts));
