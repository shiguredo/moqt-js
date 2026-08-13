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
import type {
  FilterRange,
  LocationFilter,
  RangeFilterParam,
  RangeFilterSpec,
} from "./message/parameter";
import { decodeObjectPropertiesTolerant, findPropertyValue } from "./properties";
import type { Property } from "./properties";

/**
 * 解決済み Location Filter
 *
 * 相対 Filter（NextGroupStart / LargestObject）は LARGEST_OBJECT で
 * 具体的な Start Location に解決される。未解決時は {0, 0} を使用する。
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
 * - NextGroupStart: LARGEST_OBJECT の Group + 1 から開始
 * - LargestObject: LARGEST_OBJECT の Location から開始
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

  const resolved = largestLocation ?? { group: 0n, object: 0n };

  switch (filter.type) {
    case "NextGroupStart":
      return { start: { group: resolved.group + 1n, object: 0n }, endGroup: undefined };
    case "LargestObject":
      return { start: resolved, endGroup: undefined };
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
// draft-ietf-moq-transport-19 Section 5.1.3 (Range Filters)
// ============================================================================

/**
 * Range Filter 評価に必要なオブジェクト属性
 *
 * draft-ietf-moq-transport-19 §5.1.3:
 * SUBGROUP_FILTER / OBJECTID_FILTER / PRIORITY_FILTER /
 * OBJECT_PROPERTY_FILTER の評価に使う。評価値がオブジェクトに明示されて
 * いない場合 (undefined) は不通過とする (フィルタは「値が Range 内」を
 * 要求するため、値がなければ満たせない)。
 */
export interface RangeFilterEvaluationContext {
  /**
   * Subgroup ID (SUBGROUP_FILTER 評価用)。
   * subgroup ストリーム経由のみ設定され、datagram 経路では undefined
   * (datagram には Subgroup ID が無い)。
   */
  subgroupId?: bigint;
  /** Object ID (OBJECTID_FILTER / OBJECT_PROPERTY_FILTER 評価用) */
  objectId: bigint;
  /**
   * Publisher Priority (PRIORITY_FILTER 評価用)。
   * 明示値のみで評価し、継承値 (Default Publisher Priority、省略時 128) の
   * 解決は行わない。datagram 経路のデフォルト値 (0) も明示値として扱わない。
   */
  publisherPriority?: number;
  /** Object Properties バイト列 (OBJECT_PROPERTY_FILTER 評価用) */
  objectProperties?: Uint8Array;
}

/**
 * 単一の値が Range 列に含まれるか判定する
 *
 * draft-ietf-moq-transport-19 §5.1.3:
 * "Each Range Filter is a sequence of Start/End (vi64) inclusive Range pairs ..."
 * 両端を含む (inclusive)。終端省略 (End なし) は open-ended (上限なし)。
 */
function rangeContains(value: bigint, ranges: FilterRange[]): boolean {
  for (const range of ranges) {
    if (value >= range.start && (range.end === undefined || value <= range.end)) {
      return true;
    }
  }
  return false;
}

/**
 * 単一の Range Filter パラメータをオブジェクトに対して評価する
 *
 * 評価値が明示されていない場合 (subgroupId undefined / publisherPriority
 * undefined / Object Properties なし / 対象 Property 不在) は不通過。
 * TRACK_PROPERTY_FILTER は track 単位の評価であり、オブジェクト評価では
 * スキップする (通過扱い。受信 PUBLISH 処理側で評価される)。
 */
function objectPassesSingleRangeFilter(
  param: RangeFilterParam,
  context: RangeFilterEvaluationContext,
): boolean {
  switch (param.type) {
    case "subgroup":
      if (context.subgroupId === undefined) {
        return false;
      }
      return rangeContains(context.subgroupId, param.ranges);
    case "objectId":
      return rangeContains(context.objectId, param.ranges);
    case "priority":
      if (context.publisherPriority === undefined) {
        return false;
      }
      return rangeContains(BigInt(context.publisherPriority), param.ranges);
    case "objectProperty": {
      if (context.objectProperties === undefined || param.propertyType === undefined) {
        return false;
      }
      // draft-ietf-moq-transport-19 §5.1.3:
      // "The Object Property Filter can be used to filter Objects with
      //  required Object Property types and values. It only filters Object
      //  Properties in the Object header, and does not evaluate Track
      //  Properties in PUBLISH messages."
      // 寛容デコードで読めた分を使用し (§12.7 の IMMUTABLE_PROPERTIES ネスト
      // 内も検索)、対象 Property が見つからない場合は不通過とする。
      const decoded = decodeObjectPropertiesTolerant(context.objectProperties);
      const value = findPropertyValue(decoded.properties, param.propertyType);
      if (value === undefined) {
        return false;
      }
      return rangeContains(value, param.ranges);
    }
    case "trackProperty":
      // 到達しない (evaluateRangeFilters が isObjectRangeFilterParam で除外済み)。
      // switch の網羅性チェックのために残す。
      return true;
    default: {
      // 網羅性チェック: 未対応の type が追加された場合にコンパイルエラーにする
      const _exhaustive: never = param.type;
      return _exhaustive;
    }
  }
}

/**
 * オブジェクト評価に使う RangeFilterParam を判定する型ガード
 *
 * - remove (Length=0) は REQUEST_UPDATE の更新操作であり、評価対象外
 * - TRACK_PROPERTY_FILTER は受信 PUBLISH 処理 (evaluateTrackPropertyFilters)
 *   で評価するため、オブジェクト評価では対象外
 *
 * @param spec - 判定する Range Filter 指定
 * @returns オブジェクト評価対象の場合は true
 */
export function isObjectRangeFilterParam(spec: RangeFilterSpec): spec is RangeFilterParam {
  return !("remove" in spec) && spec.type !== "trackProperty";
}

/**
 * RangeFilterParam を SetID でグループ化する
 *
 * draft-ietf-moq-transport-19 §5.1.3:
 * 同一 SetID のフィルタは AND で結合するため、SetID ごとのグループにまとめる。
 */
function groupBySetId(params: RangeFilterParam[]): Map<number, RangeFilterParam[]> {
  const groups = new Map<number, RangeFilterParam[]>();
  for (const param of params) {
    const group = groups.get(param.setId);
    if (group === undefined) {
      groups.set(param.setId, [param]);
    } else {
      group.push(param);
    }
  }
  return groups;
}

/**
 * Range Filter 群をオブジェクトに対して評価する
 *
 * draft-ietf-moq-transport-19 §5.1.3:
 * "All filter parameters with the same SetID value are combined using logical
 *  "AND" operations, then all the resulting sets are combined using logical
 *  "OR" operations."
 * 同一 SetID は AND、異なる SetID の結果は OR で結合する。
 * 結合の対象は TRACK_PROPERTY_FILTER を含む全てのフィルタパラメータである
 * ため、PUBLISH 時に確定した track 評価結果 (SetID ごと) を
 * trackResultsBySetId で受け取り、同一 SetID のオブジェクトフィルタと
 * AND 結合する。
 *
 * - フィルタなし (undefined / 空配列) は全通過
 * - Length=0 の削除エントリ (RangeFilterRemove) は評価対象から除外する
 *   (REQUEST_UPDATE の更新操作であり、評価時には意味を持たない)
 * - TRACK_PROPERTY_FILTER は trackResultsBySetId で受け取る (オブジェクト
 *   評価では直接評価しない。MoqtObject に Track Properties はない)
 *
 * @param rangeFilters - 評価する Range Filter 指定 (SUBSCRIBE / REQUEST_UPDATE 由来)
 * @param context - オブジェクトの評価属性
 * @param trackResultsBySetId - PUBLISH 時の TRACK_PROPERTY_FILTER 評価結果
 *                              (SetID ごと。undefined は TRACK_PROPERTY_FILTER なし)
 * @returns 通過する場合は true
 */
export function evaluateRangeFilters(
  rangeFilters: RangeFilterSpec[] | undefined,
  context: RangeFilterEvaluationContext,
  trackResultsBySetId?: Map<number, boolean>,
): boolean {
  if (rangeFilters === undefined || rangeFilters.length === 0) {
    // オブジェクトフィルタが無い場合は track 評価結果のみで判定する
    if (trackResultsBySetId === undefined || trackResultsBySetId.size === 0) {
      return true;
    }
    // SetID 間 OR: いずれかの SetID で track 通過なら全通過
    for (const passes of trackResultsBySetId.values()) {
      if (passes) {
        return true;
      }
    }
    return false;
  }
  const params = rangeFilters.filter((spec) => isObjectRangeFilterParam(spec));
  if (
    params.length === 0 &&
    (trackResultsBySetId === undefined || trackResultsBySetId.size === 0)
  ) {
    return true;
  }

  // 評価対象の SetID 集合を収集する (オブジェクトフィルタ + track フィルタ)
  const setIds = new Set<number>();
  for (const param of params) {
    setIds.add(param.setId);
  }
  if (trackResultsBySetId !== undefined) {
    for (const setId of trackResultsBySetId.keys()) {
      setIds.add(setId);
    }
  }

  // SetID ごとに AND (track 結果 + オブジェクトフィルタ)、SetID 間は OR で結合
  for (const setId of setIds) {
    // track 結果: その SetID に TRACK_PROPERTY_FILTER が無い場合は通過扱い
    if (trackResultsBySetId !== undefined && trackResultsBySetId.get(setId) === false) {
      continue;
    }
    // オブジェクトフィルタ: その SetID のフィルタが全て通過すれば SetID 通過
    const objectGroup = params.filter((param) => param.setId === setId);
    if (objectGroup.every((param) => objectPassesSingleRangeFilter(param, context))) {
      return true;
    }
  }
  return false;
}

/**
 * TRACK_PROPERTY_FILTER を Track Properties に対して評価する
 *
 * draft-ietf-moq-transport-19 §5.1.3:
 * "The Track Property Filter can be used in SUBSCRIBE_TRACKS to filter
 *  PUBLISH messages with required Track Property types and values."
 * 受信 PUBLISH 処理で、マッチした SUBSCRIBE_TRACKS の rangeFilters から
 * TRACK_PROPERTY_FILTER を抽出して評価する。
 *
 * - TRACK_PROPERTY_FILTER が無い場合は全通過
 * - SetID ごとに AND、異なる SetID の結果は OR (他の Range Filter と同じ規則)
 * - 対象 Property の検索は §12.7 に従い IMMUTABLE_PROPERTIES ネスト内も含む
 *   (findPropertyValue)
 * - 対象 Property が見つからない・値が Range 外の場合は不通過
 *
 * @param rangeFilters - SUBSCRIBE_TRACKS の rangeFilters (undefined は全通過)
 * @param trackProperties - 受信 PUBLISH の Track Properties (decodeProperties 済み)
 * @returns 通過する場合は true
 */
export function evaluateTrackPropertyFilters(
  rangeFilters: RangeFilterSpec[] | undefined,
  trackProperties: ReadonlyArray<Property>,
): boolean {
  const results = evaluateTrackPropertyFiltersBySetId(rangeFilters, trackProperties);
  if (results === undefined || results.size === 0) {
    return true;
  }
  for (const passes of results.values()) {
    if (passes) {
      return true;
    }
  }
  return false;
}

/**
 * TRACK_PROPERTY_FILTER を SetID ごとに評価する
 *
 * draft-ietf-moq-transport-19 §5.1.3:
 * "All filter parameters with the same SetID value are combined using logical
 *  "AND" operations, then all the resulting sets are combined using logical
 *  "OR" operations."
 * 結合規則は TRACK_PROPERTY_FILTER とオブジェクトフィルタをまたいで適用される
 * ため、PUBLISH 時に確定する track 評価結果を SetID ごとに返し、
 * evaluateRangeFilters (オブジェクト評価) が同一 SetID のオブジェクトフィルタ
 * と AND 結合する。
 *
 * @param rangeFilters - SUBSCRIBE_TRACKS の rangeFilters (undefined は全通過)
 * @param trackProperties - 受信 PUBLISH の Track Properties (decodeProperties 済み)
 * @returns SetID ごとの評価結果。TRACK_PROPERTY_FILTER が無い場合は undefined
 */
export function evaluateTrackPropertyFiltersBySetId(
  rangeFilters: RangeFilterSpec[] | undefined,
  trackProperties: ReadonlyArray<Property>,
): Map<number, boolean> | undefined {
  if (rangeFilters === undefined || rangeFilters.length === 0) {
    return undefined;
  }
  const params = rangeFilters.filter(
    (spec): spec is RangeFilterParam => !("remove" in spec) && spec.type === "trackProperty",
  );
  if (params.length === 0) {
    return undefined;
  }

  const results = new Map<number, boolean>();
  for (const group of groupBySetId(params).values()) {
    const groupPasses = group.every((param) => {
      if (param.propertyType === undefined) {
        return false;
      }
      const value = findPropertyValue(trackProperties, param.propertyType);
      if (value === undefined) {
        return false;
      }
      return rangeContains(value, param.ranges);
    });
    results.set(group[0].setId, groupPasses);
  }
  return results;
}

/**
 * REQUEST_UPDATE の Range Filter 更新を現在のフィルタ状態に適用する
 *
 * draft-ietf-moq-transport-19 §5.1.3:
 * "In REQUEST_UPDATE, Length can be 0 to remove a filter parameter or
 *  non-zero to replace that entire filter parameter including all sets
 *  and Property Types. If a filter parameter is omitted from
 *  REQUEST_UPDATE, the value is unchanged."
 *
 * - remove (Length=0): 対応する Parameter Type のフィルタを全て削除する
 *   (削除は Parameter Type 単位であり、SetID / Property Type は区別しない。
 *   Length=0 のワイヤ表現に SetID が含まれないため)。
 * - 置換 (Length 非ゼロ): 対応する Parameter Type 全体 (全 SetID・全
 *   Property Type) を置換する。同一 update 内の複数インスタンスは
 *   「置換後の新しい状態」を構成するため、まとめて追加される。
 * - update に含まれないフィルタは不変
 *
 * @param current - 現在のフィルタ状態 (undefined はフィルタなし)
 * @param update - REQUEST_UPDATE で送信した Range Filter 指定 (undefined は不変)
 * @returns 適用後のフィルタ状態
 */
export function mergeRangeFilters(
  current: RangeFilterSpec[] | undefined,
  update: RangeFilterSpec[] | undefined,
): RangeFilterSpec[] | undefined {
  if (update === undefined || update.length === 0) {
    return current;
  }
  const result: RangeFilterSpec[] = current === undefined ? [] : [...current];

  // 削除 (Length=0) を先に適用する。
  // draft-ietf-moq-transport-19 §5.1.3:
  // "Length can be 0 to remove a filter parameter" — 削除は Parameter Type
  // 単位であり、SetID / Property Type は区別しない (encodeRangeFilter の
  // remove は Length=0 のみをエンコードする)。
  for (const spec of update) {
    if (!("remove" in spec && spec.remove)) {
      continue;
    }
    for (let i = result.length - 1; i >= 0; i--) {
      const existing = result[i];
      if ("remove" in existing) {
        continue;
      }
      if (existing.type === spec.type) {
        result.splice(i, 1);
      }
    }
  }

  // 置換 (Length 非ゼロ) を適用する。
  // draft-ietf-moq-transport-19 §5.1.3:
  // "non-zero to replace that entire filter parameter including all sets
  //  and Property Types" — 置換は Parameter Type 全体 (全 SetID・全 Property
  //  Type) を対象とする。同一 update 内の複数インスタンスは置換後の新しい
  // 状態の一部であり、最初のインスタンスで既存を全て除去した後、全
  // インスタンスを追加する。
  const replacedTypes = new Set<string>();
  for (const spec of update) {
    if ("remove" in spec && spec.remove) {
      continue;
    }
    const param = spec as RangeFilterParam;
    if (!replacedTypes.has(param.type)) {
      for (let i = result.length - 1; i >= 0; i--) {
        const existing = result[i];
        if ("remove" in existing) {
          continue;
        }
        if (existing.type === param.type) {
          result.splice(i, 1);
        }
      }
      replacedTypes.add(param.type);
    }
    result.push(param);
  }
  return result;
}
