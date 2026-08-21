/**
 * Location Filter マッチング
 *
 * draft-ietf-moq-transport-19 Section 5.1.2 (Location Filter):
 * Object の Location が Subscription の Location Filter にマッチするかどうかを判定する。
 *
 * 通過条件: Object Location >= Start Location。
 * End Group があるときは Object Group <= End Group。
 */

import type { Location } from "./message/types";
import {
  type FilterRange,
  type LocationFilter,
  type RangeFilterParam,
  type RangeFilterSpec,
} from "./message/parameter";
import { decodeObjectPropertiesTolerant, type Property } from "./properties";

/**
 * 解決済み Location Filter
 *
 * 相対 Filter（NextGroupStart / LargestObject）は LARGEST_OBJECT から
 * 具体的な Start Location に解決される（詳細は resolveFilter を参照）。
 * LARGEST_OBJECT 未受信（コンテンツ未配信）時は {0, 0} から開始する
 * (draft-ietf-moq-transport-19 Section 5.1.2)。
 */
export interface ResolvedFilter {
  /** 開始 Location（この Location 以上の Object が通過） */
  start: Location;
  /** 終了 Group（この Group 以下の Object が通過。undefined は無制限） */
  endGroup: bigint | undefined;
}

/**
 * LocationFilter を具体的な ResolvedFilter に解決する
 *
 * draft-ietf-moq-transport-19 Section 5.1.2:
 * - NextGroupStart: LARGEST_OBJECT の Group + 1 から開始。未配信時は {0, 0} から開始
 * - LargestObject: {LARGEST_OBJECT の Group, LARGEST_OBJECT の Object + 1} から開始。
 *   未配信時は {0, 0} から開始
 * - AbsoluteStart: 指定された Location から開始
 * - AbsoluteRange: 指定された Location から開始し、End Group = Start.Group + EndGroupDelta
 *
 * @param filter - LocationFilter（省略時は全 Object 通過）
 * @param largestLocation - SUBSCRIBE_OK / REQUEST_UPDATE_OK の LARGEST_OBJECT（未受信時は null）
 */
export function resolveFilter(
  filter: LocationFilter | undefined,
  largestLocation: Location | null,
): ResolvedFilter | undefined {
  if (filter === undefined) {
    return undefined;
  }

  switch (filter.type) {
    case "NextGroupStart":
      // 未配信時 (LARGEST_OBJECT 省略) は仕様どおり {0, 0} から開始する。
      // フォールバック値に +1 を適用すると未配信時に {0, 1} になる罠があるため、
      // null を先に分岐する
      if (largestLocation === null) {
        return { start: { group: 0n, object: 0n }, endGroup: undefined };
      }
      return {
        start: { group: largestLocation.group + 1n, object: 0n },
        endGroup: undefined,
      };
    case "LargestObject":
      // NextGroupStart と同様に、未配信時は {0, 0} から開始する
      if (largestLocation === null) {
        return { start: { group: 0n, object: 0n }, endGroup: undefined };
      }
      // Section 5.1.2: {Largest Object.Group, Largest Object.Object + 1}
      // §10.12.2.1 の Joining Fetch は End Location を {Joining Location.Group,
      // Joining Location.Object + 1} と定義し、Note では「the last Object included
      // in the Joining FETCH response is the Object at the Joining Location」と
      // 説明される。Fetch は {G, O} まで、Subscribe は {G, O+1} からとなり
      // 連続・非重複になる
      return {
        start: { group: largestLocation.group, object: largestLocation.object + 1n },
        endGroup: undefined,
      };
    case "AbsoluteStart":
      return { start: filter.startLocation, endGroup: undefined };
    case "AbsoluteRange":
      return {
        start: filter.startLocation,
        endGroup: filter.startLocation.group + filter.endGroupDelta,
      };
    default: {
      // 網羅性チェック: 未対応の filter type が追加された場合にコンパイルエラーにする
      const _exhaustive: never = filter;
      return _exhaustive;
    }
  }
}

/**
 * Object の Location が ResolvedFilter にマッチするかどうかを判定する
 *
 * draft-ietf-moq-transport-19 Section 5.1.2:
 * 通過条件: Object Location >= Start。End Group があるときは Group <= End Group。
 *
 * Location の比較は Group を先に比較し、同一 Group 内では Object を比較する。
 *
 * @param objectLocation - Object の Location
 * @param filter - 解決済み Filter（undefined は全 Object 通過）
 * @returns マッチすれば true
 */
export function objectMatchesFilter(
  objectLocation: Location,
  filter: ResolvedFilter | undefined,
): boolean {
  // filter なしは全 Object 通過
  if (filter === undefined) {
    return true;
  }

  // Object Location >= Start Location
  if (objectLocation.group < filter.start.group) {
    return false;
  }
  if (objectLocation.group === filter.start.group && objectLocation.object < filter.start.object) {
    return false;
  }

  // End Group があるときは Object Group <= End Group
  if (filter.endGroup !== undefined && objectLocation.group > filter.endGroup) {
    return false;
  }

  return true;
}

// ============================================================================
// Range Filter マッチング
// draft-ietf-moq-transport-19 Section 5.1.3
// ============================================================================

/**
 * オブジェクトの評価値
 *
 * Range Filter の評価に使うオブジェクトのフィールド。
 * 値が明示されていないフィールド (undefined) は不通過として扱う
 * (フィルタは「値が Range 内」を要求するため)。
 */
export interface RangeFilterValues {
  /** Subgroup ID (SUBGROUP_FILTER の評価対象) */
  subgroupId?: bigint;
  /** Object ID (OBJECTID_FILTER の評価対象) */
  objectId: bigint;
  /** Publisher Priority (PRIORITY_FILTER の評価対象。明示値のみ) */
  publisherPriority?: number;
  /** Object Properties バイト列 (OBJECT_PROPERTY_FILTER の評価対象) */
  objectProperties?: Uint8Array;
}

/**
 * Range Filter の評価 (マッチング) を行う
 *
 * draft-ietf-moq-transport-19 Section 5.1.3:
 * - 同一 SetID のフィルタは AND、異なる SetID の結果は OR で結合する
 * - Range の包含判定は両端含む (inclusive)
 * - 終端省略 (End なし) は open-ended (上限なし)
 * - Length=0 の削除エントリ (RangeFilterRemove) は評価対象から除外する
 *
 * フィルタなし (空配列) は全通過。評価値が明示されていないオブジェクト
 * (subgroupId / publisherPriority が undefined) は不通過。
 * TRACK_PROPERTY_FILTER は track 単位の評価 (§5.1.3) であり、オブジェクト受信
 * 経路では評価しない (常に通過扱い)。
 *
 * @param rangeFilters - デコード済みの Range Filter 指定
 * @param values - オブジェクトの評価値
 * @returns マッチすれば true
 */
export function rangeFiltersMatch(
  rangeFilters: RangeFilterSpec[],
  values: RangeFilterValues,
): boolean {
  // フィルタなしは全通過
  if (rangeFilters.length === 0) {
    return true;
  }

  // SetID ごとにグループ化する (同一 SetID は AND、異なる SetID は OR)
  const filtersBySetId = new Map<number, RangeFilterParam[]>();
  for (const spec of rangeFilters) {
    // Length=0 の削除エントリは評価対象から除外する (REQUEST_UPDATE の更新操作)
    if ("remove" in spec) {
      continue;
    }
    const list = filtersBySetId.get(spec.setId) ?? [];
    list.push(spec);
    filtersBySetId.set(spec.setId, list);
  }

  // すべて削除エントリのみの場合 (評価対象フィルタなし) は全通過
  if (filtersBySetId.size === 0) {
    return true;
  }

  // いずれかの SetID グループがすべて通過すれば OR で全体が通過
  for (const specs of filtersBySetId.values()) {
    if (specs.every((spec) => rangeFilterParamMatches(spec, values))) {
      return true;
    }
  }
  return false;
}

/**
 * 単一の Range Filter パラメータがオブジェクトにマッチするか判定する
 */
function rangeFilterParamMatches(param: RangeFilterParam, values: RangeFilterValues): boolean {
  switch (param.type) {
    case "subgroup":
      // Subgroup ID が明示されていないオブジェクト (datagram 経路等) は不通過
      if (values.subgroupId === undefined) {
        return false;
      }
      return rangeContainsValue(param.ranges, values.subgroupId);
    case "objectId":
      return rangeContainsValue(param.ranges, values.objectId);
    case "priority":
      // Publisher Priority が明示されていないオブジェクトは不通過。
      // datagram 経路の publisherPriority = 0 (実装上のはけ口) は評価値として
      // 使わない (明示値のみで評価する)
      if (values.publisherPriority === undefined) {
        return false;
      }
      return rangeContainsValue(param.ranges, BigInt(values.publisherPriority));
    case "objectProperty": {
      if (param.propertyType === undefined) {
        return false;
      }
      // 寛容デコードで Object Properties から対象 Property Type の値を抽出する
      const propertyValue = extractObjectPropertyValue(values.objectProperties, param.propertyType);
      if (propertyValue === undefined) {
        return false;
      }
      return rangeContainsValue(param.ranges, propertyValue);
    }
    case "trackProperty":
      // TRACK_PROPERTY_FILTER は track 単位の評価であり、オブジェクト受信経路
      // では評価しない (常に通過扱い。受信 PUBLISH 処理で評価される)
      return true;
    default: {
      // 網羅性チェック: 未対応の filter type が追加された場合にコンパイルエラーにする
      const _exhaustive: never = param.type;
      return _exhaustive;
    }
  }
}

/**
 * 値が Range 列のいずれかに含まれるか判定する (両端含む / open-ended 対応)
 */
function rangeContainsValue(ranges: FilterRange[], value: bigint): boolean {
  for (const range of ranges) {
    if (value < range.start) {
      continue;
    }
    // 終端省略 (End なし) は open-ended (上限なし)
    if (range.end === undefined || value <= range.end) {
      return true;
    }
  }
  return false;
}

/**
 * Object Properties バイト列から対象 Property Type の値を寛容デコードで抽出する
 *
 * draft-ietf-moq-transport-19 §12.7:
 * 「When looking for the value of a property, processors MUST search both the
 *  mutable properties and the contents of Immutable Properties.」
 * IMMUTABLE_PROPERTIES (0x0B) のネスト内も検索する。
 *
 * デコード不能・対象 Property ID 不在の場合は undefined を返す。
 */
function extractObjectPropertyValue(
  objectProperties: Uint8Array | undefined,
  targetType: bigint,
): bigint | undefined {
  if (objectProperties === undefined) {
    return undefined;
  }
  const { properties } = decodeObjectPropertiesTolerant(objectProperties);
  return findPropertyValueInList(properties, targetType);
}

/**
 * Property 列から対象 Type の varint 値を検索する (IMMUTABLE_PROPERTIES ネスト内も含む)
 *
 * draft-ietf-moq-transport-19 §12.7:
 * 「When looking for the value of a property, processors MUST search both the
 *  mutable properties and the contents of Immutable Properties.」
 * IMMUTABLE_PROPERTIES (0x0B) のネスト内も検索する。
 *
 * 寛容デコード経路では IMMUTABLE_PROPERTIES の再帰深さに上限を設ける。
 * 悪意ある深いネストでスタックオーバーフロー (RangeError) に至らないようにする
 * ためである (Track 向け decodeProperties は再帰ネストを MalformedTrackError で
 * 拒否するが、寛容経路は検証しない)。
 *
 * OBJECT_PROPERTY_FILTER (Object Properties) と TRACK_PROPERTY_FILTER
 * (Track Properties) の両方で使用する共通ヘルパ。
 *
 * @returns 対象 Type の varint 値。デコード不能・対象不在・深さ上限超過は undefined
 */
function findPropertyValueInList(properties: Property[], targetType: bigint): bigint | undefined {
  return findPropertyValueRecursive(properties, targetType, 0);
}

function findPropertyValueRecursive(
  properties: Property[],
  targetType: bigint,
  depth: number,
): bigint | undefined {
  // 再帰深さの上限 (IMMUTABLE_PROPERTIES ネスト)。§12.7 はネストを禁止しており、
  // 上限超過は不正データとして undefined (不通過) を返す
  if (depth > MAX_PROPERTY_NESTING_DEPTH) {
    return undefined;
  }
  for (const property of properties) {
    if (property.id === targetType) {
      if (property.value !== undefined) {
        return property.value;
      }
      return undefined;
    }
    // draft-ietf-moq-transport-19 §12.7: IMMUTABLE_PROPERTIES のネスト内も検索する
    if (property.id === 0x0bn && property.data !== undefined) {
      const inner = decodeObjectPropertiesTolerant(property.data);
      const innerValue = findPropertyValueRecursive(inner.properties, targetType, depth + 1);
      if (innerValue !== undefined) {
        return innerValue;
      }
    }
  }
  return undefined;
}

/** IMMUTABLE_PROPERTIES 再帰検索の深さ上限 */
const MAX_PROPERTY_NESTING_DEPTH = 8;

/**
 * TRACK_PROPERTY_FILTER の評価 (受信 PUBLISH の Track Properties に対する検索)
 *
 * draft-ietf-moq-transport-19 §5.1.3:
 * 「The Track Property Filter can be used in SUBSCRIBE_TRACKS to filter
 *  PUBLISH messages with required Track Property types and values. PUBLISH
 *  messages which pass the filter will be forwarded」
 *
 * 同一 SetID のフィルタは AND、異なる SetID の結果は OR で結合する (Range Filter
 * 共通の規則)。Length=0 の削除エントリは評価対象から除外する。
 *
 * 対象 Property の検索は §12.7「When looking for the value of a property,
 * processors MUST search both the mutable properties and the contents of
 * Immutable Properties.」に従い、IMMUTABLE_PROPERTIES ネスト内も含める。
 *
 * @param rangeFilters - SUBSCRIBE_TRACKS で指定された Range Filters (0x29 を含む)
 * @param trackProperties - 受信 PUBLISH の Track Properties (decodeProperties の出力)
 * @returns マッチすれば true
 */
export function trackPropertyFiltersMatch(
  rangeFilters: RangeFilterSpec[],
  trackProperties: Property[],
): boolean {
  // 評価対象の TRACK_PROPERTY_FILTER (0x29) のみ抽出する
  const filters: RangeFilterParam[] = [];
  for (const spec of rangeFilters) {
    if ("remove" in spec) {
      continue;
    }
    if (spec.type === "trackProperty") {
      filters.push(spec);
    }
  }
  // 0x29 が指定されていない場合 (または削除エントリのみ) は全通過
  if (filters.length === 0) {
    return true;
  }

  // SetID ごとにグループ化する (同一 SetID は AND、異なる SetID は OR)
  const filtersBySetId = new Map<number, RangeFilterParam[]>();
  for (const spec of filters) {
    const list = filtersBySetId.get(spec.setId) ?? [];
    list.push(spec);
    filtersBySetId.set(spec.setId, list);
  }

  for (const specs of filtersBySetId.values()) {
    if (specs.every((spec) => trackPropertyFilterParamMatches(spec, trackProperties))) {
      return true;
    }
  }
  return false;
}

/**
 * 単一の TRACK_PROPERTY_FILTER パラメータが Track Properties にマッチするか判定する
 */
function trackPropertyFilterParamMatches(
  param: RangeFilterParam,
  trackProperties: Property[],
): boolean {
  if (param.propertyType === undefined) {
    return false;
  }
  const propertyValue = findTrackPropertyValue(trackProperties, param.propertyType);
  if (propertyValue === undefined) {
    return false;
  }
  return rangeContainsValue(param.ranges, propertyValue);
}

/**
 * Track Properties から対象 Type の varint 値を検索する
 *
 * draft-ietf-moq-transport-19 §12.7:
 * IMMUTABLE_PROPERTIES のネスト内も検索する (共通ヘルパ findPropertyValueInList を使用)。
 */
function findTrackPropertyValue(properties: Property[], targetType: bigint): bigint | undefined {
  return findPropertyValueInList(properties, targetType);
}
