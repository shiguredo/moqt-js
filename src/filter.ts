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
import type { LocationFilter } from "./message/parameter";

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
