/**
 * session/params.ts の純粋関数の Property-Based Tests
 * draft-ietf-moq-transport-21 Section 3.3.2 (Range Filters) / Section 8.2 (Location) /
 * Section 8.7 (Track Namespace) / Section 9.20 (Message Parameter)
 *
 * 対象は Range Filter のマージ・送信前検証、Message Parameter 構築の round-trip、
 * Location の順序、Track Namespace の前方一致、setTimeout 遅延のクランプである。
 *
 * buildPublishParameters / buildPublishTrackProperties / buildSubscribeParameters の
 * 基本オプション / extractLargestLocation / extractForwardState /
 * classifyIncomingStreamType / calculateObjectIdDelta は src/session.prop.ts で
 * 検証済みのため、本ファイルでは重複して扱わない。
 *
 * 対応する単体テスト (src/session/params.test.ts) から削除した固定値ケース:
 * - clampTimeoutMs: 通常値 / 1n / 上限ちょうど / 上限 +1 / 2^62 / 2^64-1
 * - matchNamespacePrefix: 完全一致 / 前方一致 / 空 prefix / prefix が長い / 不一致 /
 *   先頭不一致 / 両方空配列
 * - namespacePrefixesOverlap: 双方向の sub-prefix / 完全一致 / 共通 prefix なし / 空 prefix
 * - validateNamespacePrefixUpdate: 重複なし / 双方向の sub-prefix / 複数既存 prefix /
 *   アクティブな既存 prefix なし
 * - compareLocations: 同一 Location / Group 比較 / Object 比較
 * - validateFetchOkEndLocation: End >= Start のとき undefined を返す判定
 * - resolveFetchStartLocation: フィルタなし / reset / 2 フィールド /
 *   3 フィールド (両方 0 を含む) / 4 フィールド (両方 0 を含む) / 相対指定 /
 *   Next Object 形式
 * - buildSubscribeParameters: authorizationToken と includeProperties の有無 /
 *   fill の有無 / 正常な rangeFilters
 * - buildFetchParameters: authorizationToken / subscriberPriority / groupOrder /
 *   filter / includeProperties の有無 / rangeFilters
 * - buildSubscribeTracksParameters: subscriberPriority / filter / fill /
 *   authorizationToken / includeProperties / rangeFilters の有無
 * - buildSubscribeNamespaceParameters: authorizationToken の有無
 * - buildTrackStatusParameters: authorizationToken と includeProperties の有無
 * - encodeAuthorizationTokenParameter / buildRangeFilterParameters: round-trip
 * - validateRangeFilterLimits: undefined / 空配列 / 上限 0 / 上限超過 / 上限以下 /
 *   削除エントリが Ranges 数に数えられないこと
 * - validateRangeFilterSpecs: undefined と空配列 / allowRemove / allowTrackProperty /
 *   同一組み合わせの重複 / SetID 違い / Property Type 違い / 削除エントリの扱い
 * - mergeRangeFilters: remove / 置換 / 同一型の複数エントリ保持
 * - validateTrackNamespaceForSend: 通常 namespace / 空 / .session / 先頭フィールドのみ判定 /
 *   32 と 33 フィールド / .session + 空 Track Name / "." 始まり / "." 単体
 */

import { test, assert } from "vite-plus/test";
import * as fc from "fast-check";
import {
  buildFetchParameters,
  buildFillParameters,
  buildRangeFilterParameters,
  buildSubscribeNamespaceParameters,
  buildSubscribeParameters,
  buildSubscribeTracksParameters,
  buildTrackStatusParameters,
  clampTimeoutMs,
  compareLocations,
  matchNamespacePrefix,
  mergeRangeFilters,
  namespacePrefixesOverlap,
  resolveFetchStartLocation,
  validateFetchOkEndLocation,
  validateNamespacePrefixUpdate,
  validateRangeFilterLimits,
  validateRangeFilterSpecs,
  validateTrackNamespaceForSend,
} from "./params";
import {
  encodeParameters,
  decodeParameters,
  decodeFillParameters,
  decodeRangeFilter,
  MAX_TRACK_NAMESPACE_FIELDS,
  type FilterRange,
  type LocationFilter,
  type Parameter,
  type RangeFilterParam,
  type RangeFilterRemove,
  type RangeFilterSpec,
} from "../message";
import { MessageParameterType, type Location } from "../message/types";
import {
  AuthorizationTokenAliasType,
  type AuthorizationToken,
} from "../message/authorizationToken";
import type {
  FetchOptions,
  FillRequestOptions,
  SubscribeOptions,
  SubscribeTracksOptions,
  TrackStatusOptions,
} from "../session";

// ============================================================================
// Arbitrary 定義
// ============================================================================

/** 0 以上のある程度大きな varint 値。エンコード可能な範囲に収める */
const varintValueArb: fc.Arbitrary<bigint> = fc.bigInt({ min: 0n, max: 1000000n });

/** uint8 (0-255) */
const uint8Arb: fc.Arbitrary<number> = fc.integer({ min: 0, max: 255 });

/** Group Order */
const groupOrderArb: fc.Arbitrary<"Ascending" | "Descending"> = fc.constantFrom(
  "Ascending" as const,
  "Descending" as const,
);

/** Location */
const locationArb: fc.Arbitrary<Location> = fc.record({
  group: varintValueArb,
  object: varintValueArb,
});

/**
 * 省略可能なフィールド用の arbitrary
 * exactOptionalPropertyTypes のため nil は undefined にする
 */
function optionalArbitrary<T>(arbitrary: fc.Arbitrary<T>): fc.Arbitrary<T | undefined> {
  return fc.option(arbitrary, { nil: undefined });
}

/**
 * Location Filter の任意構築
 *
 * draft-ietf-moq-transport-21 §9.20.10 のフィールド数 0〜4 を網羅する。
 * 3 / 4 フィールドの End Group 超過は送信前に拒否される仕様のため、
 * 値は小さく抑えて常にエンコード可能にする。
 */
const locationFilterArb: fc.Arbitrary<LocationFilter> = fc.oneof(
  fc.constant({ reset: true } as const),
  fc.record({ startGroup: varintValueArb }),
  fc.record({ startGroup: varintValueArb, startObject: varintValueArb }),
  fc.record({
    startGroup: varintValueArb,
    startObject: varintValueArb,
    endGroupDelta: varintValueArb,
  }),
  fc.record({
    startGroup: varintValueArb,
    startObject: varintValueArb,
    endGroupDelta: varintValueArb,
    endObject: varintValueArb,
  }),
);

/** Authorization Token（値を持つ USE_VALUE 表現） */
const authorizationTokenArb: fc.Arbitrary<AuthorizationToken> = fc.record({
  aliasType: fc.constant(AuthorizationTokenAliasType.USE_VALUE),
  tokenType: fc.bigInt({ min: 0n, max: 1000n }),
  tokenValue: fc.uint8Array({ maxLength: 32 }).map((bytes) => new Uint8Array(bytes)),
});

/**
 * Range Filter の 1 Range 列を生成する arbitrary を作る
 *
 * draft-ietf-moq-transport-21 §8.6 の delta エンコーディングが成立するよう、
 * 前の Range の End 以降から次の Start を積み上げる。末尾 Range だけは
 * End 省略 (open-ended) を許す。
 *
 * @param maxValue - 1 ステップあたりの最大差分
 * @param maxLength - Range 列の最大長
 */
function filterRangesArbitrary(maxValue: bigint, maxLength: number): fc.Arbitrary<FilterRange[]> {
  return fc
    .array(
      fc.record({
        startGap: fc.bigInt({ min: 0n, max: maxValue }),
        endGap: fc.bigInt({ min: 0n, max: maxValue }),
        openEnded: fc.boolean(),
      }),
      { minLength: 1, maxLength },
    )
    .map((entries) => {
      const ranges: FilterRange[] = [];
      let cursor = 0n;
      for (const [index, entry] of entries.entries()) {
        const start = cursor + entry.startGap;
        if (index === entries.length - 1 && entry.openEnded) {
          ranges.push({ start });
          continue;
        }
        const end = start + entry.endGap;
        ranges.push({ start, end });
        cursor = end;
      }
      return ranges;
    });
}

/**
 * Range Filter パラメータ（追加）の任意構築
 *
 * PRIORITY_FILTER (0x27) は 8 bit の値しか載せられないため、
 * Range 列を累積しても 255 を超えない範囲に限定する。
 */
const rangeFilterParamArb: fc.Arbitrary<RangeFilterParam> = fc.oneof(
  fc.record({
    type: fc.constant("priority" as const),
    setId: uint8Arb,
    ranges: filterRangesArbitrary(25n, 5),
  }),
  fc.record({
    type: fc.constantFrom("subgroup" as const, "objectId" as const),
    setId: uint8Arb,
    ranges: filterRangesArbitrary(1000n, 5),
  }),
  fc.record({
    type: fc.constantFrom("objectProperty" as const, "trackProperty" as const),
    setId: uint8Arb,
    // Property Type は偶数でなければならない (§9.20.14 / §9.20.15)
    propertyType: fc.bigInt({ min: 0n, max: 500000n }).map((value) => value * 2n),
    ranges: filterRangesArbitrary(1000n, 5),
  }),
);

/** TRACK_PROPERTY_FILTER (0x29) を含まない Range Filter パラメータ（追加） */
const nonTrackRangeFilterParamArb: fc.Arbitrary<RangeFilterParam> = rangeFilterParamArb.filter(
  (spec) => spec.type !== "trackProperty",
);

/** Range Filter の削除指定（Length = 0、REQUEST_UPDATE のみ） */
const rangeFilterRemoveArb: fc.Arbitrary<RangeFilterRemove> = fc
  .constantFrom(
    "subgroup" as const,
    "objectId" as const,
    "priority" as const,
    "objectProperty" as const,
    "trackProperty" as const,
  )
  .map((type) => ({ type, remove: true }));

/** Range Filter の送信指定（追加または削除） */
const rangeFilterSpecArb: fc.Arbitrary<RangeFilterSpec> = fc.oneof(
  rangeFilterParamArb,
  rangeFilterRemoveArb,
);

/**
 * Range Filter の同一性キー (Parameter Type, SetID, Property Type)
 *
 * draft-ietf-moq-transport-21 §3.3.2:
 * "the same combination of Parameter Type, SetID, and Property Type
 *  (only in the Track and Object Property Filters) repeat in any message"
 * の組み合わせを表す。削除エントリは SetID / Property Type を持たない。
 */
function filterKeyOf(spec: RangeFilterSpec): string {
  if ("remove" in spec) {
    return `${spec.type}:remove`;
  }
  const propertyType = spec.propertyType === undefined ? "" : spec.propertyType.toString();
  return `${spec.type}:${spec.setId}:${propertyType}`;
}

/**
 * Range Filter の種別を Message Parameter Type に対応させる
 * draft-ietf-moq-transport-21 §9.20.11〜§9.20.15
 */
function rangeFilterParameterTypeOf(
  type: "subgroup" | "objectId" | "priority" | "objectProperty" | "trackProperty",
): number {
  switch (type) {
    case "subgroup":
      return MessageParameterType.SUBGROUP_FILTER;
    case "objectId":
      return MessageParameterType.OBJECTID_FILTER;
    case "priority":
      return MessageParameterType.PRIORITY_FILTER;
    case "objectProperty":
      return MessageParameterType.OBJECT_PROPERTY_FILTER;
    case "trackProperty":
      return MessageParameterType.TRACK_PROPERTY_FILTER;
    default: {
      const exhaustive: never = type;
      return exhaustive;
    }
  }
}

/** 同一キーを持たない Range Filter 指定列（追加のみ） */
const uniqueRangeFilterParamsArb: fc.Arbitrary<RangeFilterParam[]> = fc.uniqueArray(
  rangeFilterParamArb,
  { maxLength: 3, selector: filterKeyOf },
);

/** 同一キーを持たない Range Filter 指定列（TRACK_PROPERTY_FILTER を含まない） */
const uniqueNonTrackRangeFilterParamsArb: fc.Arbitrary<RangeFilterParam[]> = fc.uniqueArray(
  nonTrackRangeFilterParamArb,
  { maxLength: 3, selector: filterKeyOf },
);

/** 同一キーを持たない Range Filter 指定列（追加と削除の混在を許す） */
const uniqueRangeFilterSpecsArb: fc.Arbitrary<RangeFilterSpec[]> = fc.uniqueArray(
  rangeFilterSpecArb,
  { maxLength: 4, selector: filterKeyOf },
);

/** Fill Request の任意構築 */
const fillRequestOptionsArb: fc.Arbitrary<FillRequestOptions> = fc.record({
  filter: optionalArbitrary(locationFilterArb),
  fillTimeout: optionalArbitrary(varintValueArb),
  subscriberPriority: optionalArbitrary(uint8Arb),
  groupOrder: optionalArbitrary(groupOrderArb),
  rangeFilters: optionalArbitrary(uniqueNonTrackRangeFilterParamsArb),
});

/** SUBSCRIBE の任意構築（params.ts が扱う全フィールド） */
const subscribeOptionsArb: fc.Arbitrary<SubscribeOptions> = fc.record({
  filter: optionalArbitrary(locationFilterArb),
  deliveryTimeout: optionalArbitrary(varintValueArb),
  subgroupDeliveryTimeout: optionalArbitrary(varintValueArb),
  subscriberPriority: optionalArbitrary(uint8Arb),
  groupOrder: optionalArbitrary(groupOrderArb),
  newGroupRequest: optionalArbitrary(varintValueArb),
  rendezvousTimeout: optionalArbitrary(varintValueArb),
  forward: optionalArbitrary(fc.boolean()),
  rangeFilters: optionalArbitrary(uniqueNonTrackRangeFilterParamsArb),
  authorizationToken: optionalArbitrary(authorizationTokenArb),
  fill: optionalArbitrary(fillRequestOptionsArb),
  includeProperties: optionalArbitrary(fc.boolean()),
});

/** FETCH の任意構築 */
const fetchOptionsArb: fc.Arbitrary<FetchOptions> = fc.record({
  filter: optionalArbitrary(locationFilterArb),
  subscriberPriority: optionalArbitrary(uint8Arb),
  groupOrder: optionalArbitrary(groupOrderArb),
  fillTimeout: optionalArbitrary(varintValueArb),
  rangeFilters: optionalArbitrary(uniqueNonTrackRangeFilterParamsArb),
  authorizationToken: optionalArbitrary(authorizationTokenArb),
  includeProperties: optionalArbitrary(fc.boolean()),
});

/** SUBSCRIBE_TRACKS の任意構築（0x29 を含む Range Filter を許す） */
const subscribeTracksOptionsArb: fc.Arbitrary<SubscribeTracksOptions> = fc.record({
  filter: optionalArbitrary(locationFilterArb),
  subscriberPriority: optionalArbitrary(uint8Arb),
  groupOrder: optionalArbitrary(groupOrderArb),
  forward: optionalArbitrary(fc.boolean()),
  rangeFilters: optionalArbitrary(uniqueRangeFilterParamsArb),
  authorizationToken: optionalArbitrary(authorizationTokenArb),
  fill: optionalArbitrary(fillRequestOptionsArb),
  includeProperties: optionalArbitrary(fc.boolean()),
});

/** TRACK_STATUS の任意構築 */
const trackStatusOptionsArb: fc.Arbitrary<TrackStatusOptions> = fc.record({
  authorizationToken: optionalArbitrary(authorizationTokenArb),
  includeProperties: optionalArbitrary(fc.boolean()),
});

/** 予約 prefix を含む Track Namespace のフィールド */
const namespaceFieldArb: fc.Arbitrary<string> = fc.constantFrom(
  "a",
  "b",
  "ab",
  "",
  ".",
  ".session",
  ".foo",
);

/** 予約 prefix を含まない Track Namespace のフィールド */
const normalNamespaceFieldArb: fc.Arbitrary<string> = fc.constantFrom("a", "b", "ab", "");

/**
 * Message Parameter を encode / decode して round-trip させる
 *
 * encodeParameters が Type 昇順に安定ソートするため、期待値も同じ規則で
 * 並べ替えてから比較する。
 */
function assertParameterRoundTrip(parameters: Parameter[]): Parameter[] {
  const [decoded] = decodeParameters(encodeParameters(parameters));
  const sorted = [...parameters].sort((a, b) => a.type - b.type);
  assert.deepEqual(decoded, sorted);
  return decoded;
}

/** パラメータ型の集合 */
function parameterTypesOf(parameters: Parameter[]): Set<number> {
  return new Set(parameters.map((parameter) => parameter.type));
}

/** Range Filter の Parameter Type 集合 (0x25-0x29) */
function isRangeFilterParameterType(type: number): boolean {
  return (
    type === MessageParameterType.SUBGROUP_FILTER ||
    type === MessageParameterType.OBJECTID_FILTER ||
    type === MessageParameterType.PRIORITY_FILTER ||
    type === MessageParameterType.OBJECT_PROPERTY_FILTER ||
    type === MessageParameterType.TRACK_PROPERTY_FILTER
  );
}

// ============================================================================
// PBT 1: mergeRangeFilters
// draft-ietf-moq-transport-21 §3.3.2 (Range Filters)
// ============================================================================

test("mergeRangeFilters: 残存する現在のエントリの後ろに update の追加エントリが並ぶ", () => {
  fc.assert(
    fc.property(uniqueRangeFilterSpecsArb, uniqueRangeFilterSpecsArb, (current, update) => {
      const updateParams = update.filter((spec): spec is RangeFilterParam => !("remove" in spec));
      const updateTypes = new Set(updateParams.map((spec) => spec.type));
      const removeTypes = new Set(
        update.filter((spec) => "remove" in spec).map((spec) => spec.type),
      );

      // §3.3.2: update に現れない型は不変、追加で指定した型は置換、remove で指定した型は
      // 全削除。現在のエントリはキーが一意なため重複排除は起きない。
      const expected = [
        ...current.filter((spec) => !updateTypes.has(spec.type) && !removeTypes.has(spec.type)),
        ...updateParams,
      ];
      assert.deepEqual(mergeRangeFilters(current, update), expected);
    }),
  );
});

test("mergeRangeFilters: 結果のキーは常に一意になる", () => {
  fc.assert(
    fc.property(uniqueRangeFilterSpecsArb, uniqueRangeFilterSpecsArb, (current, update) => {
      const keys = mergeRangeFilters(current, update).map((spec) => filterKeyOf(spec));
      assert.equal(new Set(keys).size, keys.length);
    }),
  );
});

test("mergeRangeFilters: update が空なら現在のエントリがそのまま残る", () => {
  fc.assert(
    fc.property(uniqueRangeFilterSpecsArb, (current) => {
      assert.deepEqual(mergeRangeFilters(current, []), current);
    }),
  );
});

test("mergeRangeFilters: 同じ update を繰り返し適用しても結果が変わらない", () => {
  fc.assert(
    fc.property(uniqueRangeFilterSpecsArb, uniqueRangeFilterSpecsArb, (current, update) => {
      const once = mergeRangeFilters(current, update);
      assert.deepEqual(mergeRangeFilters(once, update), once);
    }),
  );
});

test("mergeRangeFilters: remove された型のエントリは現在の値も update の値も残らない", () => {
  fc.assert(
    fc.property(
      uniqueRangeFilterSpecsArb,
      uniqueRangeFilterSpecsArb,
      rangeFilterRemoveArb,
      (current, update, remove) => {
        // 同一 update 内の非 remove エントリは削除より優先されるため、
        // 当該型の追加を含まない update で削除の効果だけを検証する
        const otherTypes = update.filter((spec) => spec.type !== remove.type);
        const merged = mergeRangeFilters(current, [...otherTypes, remove]);
        for (const spec of merged) {
          assert.notEqual(spec.type, remove.type);
        }
      },
    ),
  );
});

test("mergeRangeFilters: 同一 update に remove と追加が混在すると追加が優先される", () => {
  fc.assert(
    fc.property(uniqueRangeFilterSpecsArb, rangeFilterParamArb, (current, param) => {
      const remove: RangeFilterRemove = { type: param.type, remove: true };
      const merged = mergeRangeFilters(current, [remove, param]);
      // 当該型は追加エントリで置換されるため、同じ型の他のエントリは残らない
      assert.deepEqual(
        merged.filter((spec) => spec.type === param.type),
        [param],
      );
    }),
  );
});

// ============================================================================
// PBT 2: validateRangeFilterLimits
// draft-ietf-moq-transport-21 §9.1.6 (MAX FILTER RANGES)
// ============================================================================

test("validateRangeFilterLimits: undefined と空配列は常に throw しない", () => {
  fc.assert(
    fc.property(fc.integer({ min: 0, max: 100 }), (peerMaxFilterRanges) => {
      validateRangeFilterLimits(undefined, peerMaxFilterRanges, "SUBSCRIBE");
      validateRangeFilterLimits([], peerMaxFilterRanges, "SUBSCRIBE");
    }),
  );
});

test("validateRangeFilterLimits: ピアの上限が 0 でフィルタがある場合は常に throw する", () => {
  fc.assert(
    fc.property(fc.uniqueArray(rangeFilterSpecArb, { minLength: 1, maxLength: 3 }), (filters) => {
      assert.throws(() => validateRangeFilterLimits(filters, 0, "SUBSCRIBE"));
    }),
  );
});

test("validateRangeFilterLimits: Ranges 総数が上限以下なら throw しない", () => {
  fc.assert(
    fc.property(
      fc.uniqueArray(rangeFilterParamArb, { maxLength: 3 }),
      fc.integer({ min: 0, max: 5 }),
      (filters, extra) => {
        const totalRanges = filters.reduce((sum, filter) => sum + filter.ranges.length, 0);
        validateRangeFilterLimits(filters, totalRanges + extra, "SUBSCRIBE");
      },
    ),
  );
});

test("validateRangeFilterLimits: Ranges 総数が上限を超えるなら throw する", () => {
  fc.assert(
    fc.property(
      fc.uniqueArray(rangeFilterParamArb, { minLength: 1, maxLength: 3 }),
      fc.integer({ min: 0, max: 5 }),
      (filters, shortfall) => {
        const totalRanges = filters.reduce((sum, filter) => sum + filter.ranges.length, 0);
        // Range 列は 1 件以上あるため総数は必ず 1 以上になり、上限は総数未満になる
        const peerMaxFilterRanges = totalRanges - shortfall - 1;
        assert.throws(() => validateRangeFilterLimits(filters, peerMaxFilterRanges, "SUBSCRIBE"));
      },
    ),
  );
});

test("validateRangeFilterLimits: 削除エントリは Ranges 総数に数えない", () => {
  fc.assert(
    fc.property(fc.uniqueArray(rangeFilterRemoveArb, { minLength: 1, maxLength: 3 }), (filters) => {
      // 上限が 1 以上であれば削除のみの指定は Ranges を消費しない
      validateRangeFilterLimits(filters, 1, "REQUEST_UPDATE");
    }),
  );
});

// ============================================================================
// PBT 3: validateRangeFilterSpecs
// draft-ietf-moq-transport-21 §3.3.2 (Range Filters)
// ============================================================================

test("validateRangeFilterSpecs: undefined と空配列は常に throw しない", () => {
  fc.assert(
    fc.property(fc.boolean(), fc.boolean(), (allowRemove, allowTrackProperty) => {
      validateRangeFilterSpecs(undefined, "SUBSCRIBE", { allowRemove, allowTrackProperty });
      validateRangeFilterSpecs([], "SUBSCRIBE", { allowRemove, allowTrackProperty });
    }),
  );
});

test("validateRangeFilterSpecs: 許可された入力では throw しない", () => {
  fc.assert(
    fc.property(
      uniqueRangeFilterSpecsArb,
      fc.boolean(),
      fc.boolean(),
      (filters, allowRemove, allowTrackProperty) => {
        // 0x29 は削除エントリでも allowTrackProperty が真のときだけ許可され、
        // 削除 (Length = 0) は allowRemove が真のときだけ許可される
        const permitted = filters.filter((spec) => {
          if (spec.type === "trackProperty" && !allowTrackProperty) {
            return false;
          }
          return !("remove" in spec) || allowRemove;
        });
        validateRangeFilterSpecs(permitted, "SUBSCRIBE", { allowRemove, allowTrackProperty });
      },
    ),
  );
});

test("validateRangeFilterSpecs: 同一キーの重複は常に throw する", () => {
  fc.assert(
    fc.property(rangeFilterParamArb, (spec) => {
      assert.throws(() =>
        validateRangeFilterSpecs([spec, spec], "SUBSCRIBE", {
          allowRemove: true,
          allowTrackProperty: true,
        }),
      );
    }),
  );
});

test("validateRangeFilterSpecs: allowRemove が false なら削除エントリで throw する", () => {
  fc.assert(
    fc.property(rangeFilterRemoveArb, (spec) => {
      assert.throws(() =>
        validateRangeFilterSpecs([spec], "SUBSCRIBE", {
          allowRemove: false,
          allowTrackProperty: true,
        }),
      );
    }),
  );
});

test("validateRangeFilterSpecs: allowTrackProperty が false なら TRACK_PROPERTY_FILTER で throw する", () => {
  fc.assert(
    fc.property(
      rangeFilterParamArb.filter((spec) => spec.type === "trackProperty"),
      (spec) => {
        assert.throws(() =>
          validateRangeFilterSpecs([spec], "SUBSCRIBE", {
            allowRemove: true,
            allowTrackProperty: false,
          }),
        );
      },
    ),
  );
});

test("validateRangeFilterSpecs: SetID が違えば重複にならない", () => {
  fc.assert(
    fc.property(rangeFilterParamArb, (spec) => {
      const otherSetId: RangeFilterSpec = { ...spec, setId: (spec.setId + 1) % 256 };
      validateRangeFilterSpecs([spec, otherSetId], "SUBSCRIBE", {
        allowRemove: true,
        allowTrackProperty: true,
      });
    }),
  );
});

test("validateRangeFilterSpecs: Property Type が違えば重複にならない", () => {
  fc.assert(
    fc.property(
      rangeFilterParamArb.filter((spec) => "propertyType" in spec),
      (spec) => {
        // Property Type は偶数でなければならないため 2 を加算して別のキーにする
        const otherPropertyType: RangeFilterSpec = {
          ...spec,
          propertyType: (spec.propertyType ?? 0n) + 2n,
        };
        validateRangeFilterSpecs([spec, otherPropertyType], "SUBSCRIBE", {
          allowRemove: true,
          allowTrackProperty: true,
        });
      },
    ),
  );
});

// ============================================================================
// PBT 4: buildRangeFilterParameters / build*Parameters の round-trip
// draft-ietf-moq-transport-21 §3.3.2 / §9.20
// ============================================================================

test("buildRangeFilterParameters: 各パラメータが decodeRangeFilter で元の指定に戻る", () => {
  fc.assert(
    fc.property(fc.uniqueArray(rangeFilterSpecArb, { maxLength: 4 }), (specs) => {
      const parameters = buildRangeFilterParameters(specs);
      assert.equal(parameters.length, specs.length);
      for (const [index, spec] of specs.entries()) {
        const parameter = parameters[index];
        assert.isDefined(parameter);
        if (parameter === undefined) {
          continue;
        }
        const [decoded, consumed] = decodeRangeFilter(spec.type, parameter.value);
        assert.deepEqual(decoded, spec);
        // 消費バイト数は Value 全体と一致する
        assert.equal(consumed, parameter.value.byteLength);
      }
    }),
  );
});

test("buildSubscribeParameters: 全フィールドの指定が round-trip し、未指定の型は現れない", () => {
  fc.assert(
    fc.property(subscribeOptionsArb, (options) => {
      const decoded = assertParameterRoundTrip(buildSubscribeParameters(options));
      const types = parameterTypesOf(decoded);

      // 指定したフィールドに対応する Parameter Type が現れる
      if (options.filter !== undefined) {
        assert.isTrue(types.has(MessageParameterType.LOCATION_FILTER));
      }
      if (options.deliveryTimeout !== undefined) {
        assert.isTrue(types.has(MessageParameterType.OBJECT_DELIVERY_TIMEOUT));
      }
      if (options.subgroupDeliveryTimeout !== undefined) {
        assert.isTrue(types.has(MessageParameterType.SUBGROUP_DELIVERY_TIMEOUT));
      }
      if (options.subscriberPriority !== undefined) {
        assert.isTrue(types.has(MessageParameterType.SUBSCRIBER_PRIORITY));
      }
      if (options.groupOrder !== undefined) {
        assert.isTrue(types.has(MessageParameterType.GROUP_ORDER));
      }
      if (options.newGroupRequest !== undefined) {
        assert.isTrue(types.has(MessageParameterType.NEW_GROUP_REQUEST));
      }
      if (options.rendezvousTimeout !== undefined) {
        assert.isTrue(types.has(MessageParameterType.RENDEZVOUS_TIMEOUT));
      }
      // FORWARD は既定値 1 のため false のときだけ送る (§9.20.19)
      assert.equal(types.has(MessageParameterType.FORWARD), options.forward === false);
      if (options.rangeFilters !== undefined) {
        for (const spec of options.rangeFilters) {
          assert.isTrue(types.has(rangeFilterParameterTypeOf(spec.type)));
        }
      }
      assert.equal(
        types.has(MessageParameterType.AUTHORIZATION_TOKEN),
        options.authorizationToken !== undefined,
      );
      assert.equal(types.has(MessageParameterType.FILL_PARAMETERS), options.fill !== undefined);
      assert.equal(
        types.has(MessageParameterType.INCLUDE_PROPERTIES),
        options.includeProperties !== undefined,
      );

      // 指定していないフィールドに対応する Parameter Type は現れない
      if (options.filter === undefined) {
        assert.isFalse(types.has(MessageParameterType.LOCATION_FILTER));
      }
      if (options.groupOrder === undefined) {
        assert.isFalse(types.has(MessageParameterType.GROUP_ORDER));
      }
      if (options.rangeFilters === undefined || options.rangeFilters.length === 0) {
        for (const type of types) {
          assert.isFalse(isRangeFilterParameterType(type));
        }
      }
    }),
  );
});

test("buildSubscribeParameters: FILL_PARAMETERS の内側が buildFillParameters と一致する", () => {
  fc.assert(
    fc.property(fillRequestOptionsArb, (fill) => {
      const parameters = buildSubscribeParameters({ fill });
      const fillParameter = parameters.find(
        (parameter) => parameter.type === MessageParameterType.FILL_PARAMETERS,
      );
      assert.isDefined(fillParameter);
      if (fillParameter === undefined) {
        return;
      }
      // encodeFillParameters は内側も Type 昇順にソートする
      const inner = decodeFillParameters(fillParameter);
      const expected = [...buildFillParameters(fill, "SUBSCRIBE")].sort((a, b) => a.type - b.type);
      assert.deepEqual(inner, expected);
    }),
  );
});

test("buildSubscribeTracksParameters: 全フィールドの指定が round-trip する", () => {
  fc.assert(
    fc.property(subscribeTracksOptionsArb, (options) => {
      const decoded = assertParameterRoundTrip(buildSubscribeTracksParameters(options));
      const types = parameterTypesOf(decoded);
      assert.equal(types.has(MessageParameterType.LOCATION_FILTER), options.filter !== undefined);
      assert.equal(
        types.has(MessageParameterType.SUBSCRIBER_PRIORITY),
        options.subscriberPriority !== undefined,
      );
      assert.equal(types.has(MessageParameterType.GROUP_ORDER), options.groupOrder !== undefined);
      assert.equal(types.has(MessageParameterType.FORWARD), options.forward === false);
      // TRACK_PROPERTY_FILTER (0x29) は SUBSCRIBE_TRACKS でのみ許可される (§3.3.2)
      if (options.rangeFilters !== undefined) {
        for (const spec of options.rangeFilters) {
          assert.isTrue(types.has(rangeFilterParameterTypeOf(spec.type)));
        }
      }
      assert.equal(
        types.has(MessageParameterType.AUTHORIZATION_TOKEN),
        options.authorizationToken !== undefined,
      );
      assert.equal(types.has(MessageParameterType.FILL_PARAMETERS), options.fill !== undefined);
      assert.equal(
        types.has(MessageParameterType.INCLUDE_PROPERTIES),
        options.includeProperties !== undefined,
      );
      // rangeFilters を指定していなければ Range Filter 系の型は現れない
      if (options.rangeFilters === undefined || options.rangeFilters.length === 0) {
        for (const type of types) {
          assert.isFalse(isRangeFilterParameterType(type));
        }
      }
    }),
  );
});

test("buildFetchParameters: 全フィールドの指定が round-trip し、未指定の型は現れない", () => {
  fc.assert(
    fc.property(fetchOptionsArb, (options) => {
      const decoded = assertParameterRoundTrip(buildFetchParameters(options));
      const types = parameterTypesOf(decoded);
      assert.equal(types.has(MessageParameterType.LOCATION_FILTER), options.filter !== undefined);
      assert.equal(
        types.has(MessageParameterType.SUBSCRIBER_PRIORITY),
        options.subscriberPriority !== undefined,
      );
      assert.equal(types.has(MessageParameterType.GROUP_ORDER), options.groupOrder !== undefined);
      assert.equal(types.has(MessageParameterType.FILL_TIMEOUT), options.fillTimeout !== undefined);
      if (options.rangeFilters !== undefined) {
        for (const spec of options.rangeFilters) {
          assert.isTrue(types.has(rangeFilterParameterTypeOf(spec.type)));
        }
      }
      assert.equal(
        types.has(MessageParameterType.AUTHORIZATION_TOKEN),
        options.authorizationToken !== undefined,
      );
      assert.equal(
        types.has(MessageParameterType.INCLUDE_PROPERTIES),
        options.includeProperties !== undefined,
      );
      if (options.rangeFilters === undefined || options.rangeFilters.length === 0) {
        for (const type of types) {
          assert.isFalse(isRangeFilterParameterType(type));
        }
      }
    }),
  );
});

test("buildSubscribeNamespaceParameters: authorizationToken の有無だけを反映する", () => {
  fc.assert(
    fc.property(optionalArbitrary(authorizationTokenArb), (authorizationToken) => {
      // SUBSCRIBE_NAMESPACE は AUTHORIZATION_TOKEN のみを載せる (§9.15)
      const parameters = buildSubscribeNamespaceParameters({ authorizationToken });
      assertParameterRoundTrip(parameters);
      assert.equal(parameters.length, authorizationToken === undefined ? 0 : 1);
    }),
  );
});

test("buildTrackStatusParameters: authorizationToken と includeProperties の有無を反映する", () => {
  fc.assert(
    fc.property(trackStatusOptionsArb, (options) => {
      const decoded = assertParameterRoundTrip(buildTrackStatusParameters(options));
      const types = parameterTypesOf(decoded);
      assert.equal(
        types.has(MessageParameterType.AUTHORIZATION_TOKEN),
        options.authorizationToken !== undefined,
      );
      assert.equal(
        types.has(MessageParameterType.INCLUDE_PROPERTIES),
        options.includeProperties !== undefined,
      );
    }),
  );
});

// ============================================================================
// PBT 5: Location の順序と FETCH の Start Location 確定
// draft-ietf-moq-transport-21 §8.2 / §9.12 / §3.3.1
// ============================================================================

test("compareLocations: 反射律と反対称律を満たす", () => {
  fc.assert(
    fc.property(locationArb, locationArb, (a, b) => {
      assert.equal(compareLocations(a, a), 0);
      // a < b なら b > a、等しければ両方 0 になる
      assert.equal(Math.sign(compareLocations(a, b)), -Math.sign(compareLocations(b, a)));
    }),
  );
});

test("compareLocations: 推移律を満たす", () => {
  fc.assert(
    fc.property(locationArb, locationArb, locationArb, (a, b, c) => {
      if (compareLocations(a, b) <= 0 && compareLocations(b, c) <= 0) {
        assert.isTrue(compareLocations(a, c) <= 0);
      }
      if (compareLocations(a, b) >= 0 && compareLocations(b, c) >= 0) {
        assert.isTrue(compareLocations(a, c) >= 0);
      }
    }),
  );
});

test("compareLocations: 仕様の辞書式順序と一致する", () => {
  fc.assert(
    fc.property(locationArb, locationArb, (a, b) => {
      // draft-ietf-moq-transport-21 §8.2:
      // "Location A < Location B if: A.Group < B.Group ||
      //  (A.Group == B.Group && A.Object < B.Object)"
      let expected = 0;
      if (a.group !== b.group) {
        expected = a.group < b.group ? -1 : 1;
      } else if (a.object !== b.object) {
        expected = a.object < b.object ? -1 : 1;
      }
      assert.equal(compareLocations(a, b), expected);
    }),
  );
});

test("validateFetchOkEndLocation: 判定が compareLocations と一致する", () => {
  fc.assert(
    fc.property(locationArb, locationArb, (startLocation, endLocation) => {
      const result = validateFetchOkEndLocation(startLocation, endLocation);
      if (compareLocations(endLocation, startLocation) < 0) {
        assert.isString(result);
      } else {
        assert.isUndefined(result);
      }
    }),
  );
});

test("resolveFetchStartLocation: 絶対開始を持つフィルタだけが Location を確定する", () => {
  fc.assert(
    fc.property(locationFilterArb, (filter) => {
      const result = resolveFetchStartLocation(filter);
      if ("reset" in filter) {
        assert.deepEqual(result, { group: 0n, object: 0n });
        return;
      }
      // 1 フィールド (相対指定) は Largest Object 依存のため確定できない
      if (!("startObject" in filter)) {
        assert.isUndefined(result);
        return;
      }
      // 2 フィールドの Next Object 形式も Largest Object 依存
      if (!("endGroupDelta" in filter) && filter.startGroup === 0n && filter.startObject === 0n) {
        assert.isUndefined(result);
        return;
      }
      assert.deepEqual(result, { group: filter.startGroup, object: filter.startObject });
    }),
  );
});

test("resolveFetchStartLocation: filter 未指定は {0, 0} を返す", () => {
  assert.deepEqual(resolveFetchStartLocation(undefined), { group: 0n, object: 0n });
});

// ============================================================================
// PBT 6: Track Namespace の前方一致
// draft-ietf-moq-transport-21 §9.18 (SUBSCRIBE_TRACKS) / §9.5.2
// ============================================================================

test("matchNamespacePrefix: 一致した場合は prefix と suffix の連結が元に戻る", () => {
  fc.assert(
    fc.property(
      fc.array(namespaceFieldArb, { maxLength: 5 }),
      fc.array(namespaceFieldArb, { maxLength: 5 }),
      (trackNamespace, namespacePrefix) => {
        const suffix = matchNamespacePrefix(trackNamespace, namespacePrefix);
        if (namespacePrefix.length > trackNamespace.length) {
          assert.isNull(suffix);
          return;
        }
        if (suffix === null) {
          // 一致しない場合は少なくとも 1 要素が異なる
          const mismatch = namespacePrefix.some((field, index) => trackNamespace[index] !== field);
          assert.isTrue(mismatch);
          return;
        }
        assert.deepEqual([...namespacePrefix, ...suffix], trackNamespace);
      },
    ),
  );
});

test("matchNamespacePrefix: prefix が空なら常に全体を suffix として返す", () => {
  fc.assert(
    fc.property(fc.array(namespaceFieldArb, { maxLength: 5 }), (trackNamespace) => {
      assert.deepEqual(matchNamespacePrefix(trackNamespace, []), trackNamespace);
    }),
  );
});

test("namespacePrefixesOverlap: 対称で、一方が他方の sub-prefix であることと同値", () => {
  fc.assert(
    fc.property(
      fc.array(namespaceFieldArb, { maxLength: 4 }),
      fc.array(namespaceFieldArb, { maxLength: 4 }),
      (a, b) => {
        const overlap = namespacePrefixesOverlap(a, b);
        assert.equal(overlap, namespacePrefixesOverlap(b, a));
        assert.equal(
          overlap,
          matchNamespacePrefix(b, a) !== null || matchNamespacePrefix(a, b) !== null,
        );
      },
    ),
  );
});

test("namespacePrefixesOverlap: 自身とは常に共通 prefix を持つ", () => {
  fc.assert(
    fc.property(fc.array(namespaceFieldArb, { maxLength: 4 }), (a) => {
      assert.isTrue(namespacePrefixesOverlap(a, a));
    }),
  );
});

test("validateNamespacePrefixUpdate: 共通 prefix を持つ既存 prefix がある場合だけ throw する", () => {
  fc.assert(
    fc.property(
      fc.array(namespaceFieldArb, { maxLength: 4 }),
      fc.array(fc.array(namespaceFieldArb, { maxLength: 4 }), { maxLength: 4 }),
      (newPrefix, activePrefixes) => {
        const overlaps = activePrefixes.some((activePrefix) =>
          namespacePrefixesOverlap(newPrefix, activePrefix),
        );
        if (overlaps) {
          assert.throws(() =>
            validateNamespacePrefixUpdate(newPrefix, activePrefixes, "SUBSCRIBE_TRACKS"),
          );
        } else {
          validateNamespacePrefixUpdate(newPrefix, activePrefixes, "SUBSCRIBE_TRACKS");
        }
      },
    ),
  );
});

// ============================================================================
// PBT 7: validateTrackNamespaceForSend
// draft-ietf-moq-transport-21 §2.4.2 / §6.5 / §8.7
// ============================================================================

test("validateTrackNamespaceForSend: 予約 prefix でもフィールド数超過でもない場合は throw しない", () => {
  fc.assert(
    fc.property(
      fc.array(normalNamespaceFieldArb, { maxLength: MAX_TRACK_NAMESPACE_FIELDS }),
      optionalArbitrary(fc.string({ maxLength: 8 })),
      (namespace, trackName) => {
        validateTrackNamespaceForSend(namespace, trackName);
      },
    ),
  );
});

test("validateTrackNamespaceForSend: 先頭フィールドが . で始まる場合は常に throw する", () => {
  fc.assert(
    fc.property(
      fc.array(normalNamespaceFieldArb, { maxLength: MAX_TRACK_NAMESPACE_FIELDS - 1 }),
      fc.constantFrom(".", ".session", ".foo"),
      fc.string({ maxLength: 8 }),
      (rest, reserved, trackName) => {
        assert.throws(() => validateTrackNamespaceForSend([reserved, ...rest], trackName));
      },
    ),
  );
});

test("validateTrackNamespaceForSend: 32 フィールドは throw せず 33 フィールド以上は throw する", () => {
  const atLimit: string[] = Array.from({ length: MAX_TRACK_NAMESPACE_FIELDS }, () => "a");
  validateTrackNamespaceForSend(atLimit);
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 8 }), (extra) => {
      const over: string[] = Array.from({ length: MAX_TRACK_NAMESPACE_FIELDS + extra }, () => "a");
      assert.throws(() => validateTrackNamespaceForSend(over));
    }),
  );
});

test("validateTrackNamespaceForSend: 予約 prefix の判定は先頭フィールドのみを見る", () => {
  fc.assert(
    fc.property(
      fc.array(normalNamespaceFieldArb, { maxLength: MAX_TRACK_NAMESPACE_FIELDS - 2 }),
      fc.constantFrom(".", ".session", ".foo"),
      (rest, reserved) => {
        // 2 番目以降に予約 prefix があっても先頭が通常なら送信できる
        validateTrackNamespaceForSend(["safe", reserved, ...rest]);
      },
    ),
  );
});

// ============================================================================
// PBT 8: clampTimeoutMs
// WHATWG HTML の setTimeout 遅延上限 (2^31 - 1 ms)
// ============================================================================

test("clampTimeoutMs: 2^31 - 1 を超える値だけが上限に張り付く", () => {
  // 境界の前後を必ず含めるため、通常値・境界近傍・varint 全域を混ぜて生成する
  const timeoutArb: fc.Arbitrary<bigint> = fc.oneof(
    fc.bigInt({ min: 0n, max: 1000n }),
    fc.bigInt({ min: 2147483640n, max: 2147483660n }),
    fc.bigInt({ min: 0n, max: 18446744073709551615n }),
  );
  fc.assert(
    fc.property(timeoutArb, (timeout) => {
      const clamped = clampTimeoutMs(timeout);
      assert.equal(clamped, Math.min(Number(timeout), 2147483647));
      assert.isTrue(clamped >= 0);
      assert.isTrue(clamped <= 2147483647);
      if (timeout <= 2147483647n) {
        assert.equal(clamped, Number(timeout));
      }
    }),
  );
});
