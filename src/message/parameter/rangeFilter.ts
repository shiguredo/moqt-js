/**
 * MOQT Range Filter
 * draft-ietf-moq-transport-21 Section 3.3.2 (Range Filters) / Section 8.6
 *
 * SUBGROUP_FILTER (0x25) / OBJECTID_FILTER (0x26) / PRIORITY_FILTER (0x27) /
 * OBJECT_PROPERTY_FILTER (0x28) / TRACK_PROPERTY_FILTER (0x29) の Value の
 * エンコードとデコードを扱う。Value は Length (vi64) + SetID + Range 列の
 * 1 Length 構造のため、Message Parameter 側では外側 Length を付加しない。
 */

import { IncompleteDataError, InvalidFilterError } from "../../error";
import { decodeVarint, encodeVarint, MAX_VARINT } from "../../varint";
import { concatUint8Arrays } from "../../bytes";
import { type Parameter } from "./common";

// ============================================================================
// Range Filters (draft-ietf-moq-transport-21 Section 3.3.2)
// ============================================================================

/**
 * Range Filter の単一 Range
 *
 * draft-ietf-moq-transport-21 Section 8.6:
 * Start は直前 Range の End からの delta（先頭は 0 から）。
 * End は当該 Start からの delta。末尾 Range のみ End 省略可（open-ended）。
 */
export interface FilterRange {
  start: bigint;
  end?: bigint;
}

/**
 * Range Filter パラメータ
 *
 * draft-ietf-moq-transport-21 Section 3.3.2:
 * 同一 SetID 内は AND、異なる SetID 間は OR。
 */
export interface RangeFilterParam {
  type: "subgroup" | "objectId" | "priority" | "objectProperty" | "trackProperty";
  setId: number;
  /** OBJECT_PROPERTY_FILTER / TRACK_PROPERTY_FILTER のみ使用。偶数であること */
  propertyType?: bigint;
  ranges: FilterRange[];
}

/**
 * Range Filter の削除（REQUEST_UPDATE で Length=0）
 */
export interface RangeFilterRemove {
  type: "subgroup" | "objectId" | "priority" | "objectProperty" | "trackProperty";
  remove: true;
}

/** Range Filter の送信指定（追加または削除） */
export type RangeFilterSpec = RangeFilterParam | RangeFilterRemove;

/**
 * Range Filter のワイヤエンコーディング
 *
 * draft-ietf-moq-transport-21 Section 8.6:
 * Value = Length (vi64) + [SetID (8 bit) + [Property Type (vi64)] + Range 列]
 * Length = 0 は削除を意味する。
 */
export function encodeRangeFilter(spec: RangeFilterSpec): Uint8Array {
  if ("remove" in spec && spec.remove) {
    // Length = 0（削除）
    return encodeVarint(0n);
  }

  const param = spec as RangeFilterParam;
  const parts: Uint8Array[] = [];

  // draft-ietf-moq-transport-21 Section 3.3.2:
  // Range Filter は 1 つ以上の Range を持つ。空の ranges はデコード側
  // (decodeRangeFilter の「no ranges」検証) が InvalidFilterError で拒否する
  // ため、送信前に検出する。
  if (param.ranges.length === 0) {
    throw new InvalidFilterError("range filter must have at least one range");
  }

  // draft-ietf-moq-transport-21 §9.20.11–§9.20.15:
  // SetID は 8 bit (0-255) のため、範囲外の値は送信できない
  if (!Number.isInteger(param.setId) || param.setId < 0 || param.setId > 255) {
    throw new InvalidFilterError(`set id out of range: ${param.setId}, expected 0-255`);
  }

  // SetID (8 bit)
  parts.push(new Uint8Array([param.setId]));

  // Property Type (vi64) - OBJECT_PROPERTY_FILTER / TRACK_PROPERTY_FILTER のみ
  if (param.type === "objectProperty" || param.type === "trackProperty") {
    if (param.propertyType === undefined) {
      throw new Error("propertyType is required for objectProperty/trackProperty filter");
    }
    // draft-ietf-moq-transport-21 §9.20.14 / §9.20.15:
    // Property Type は偶数でなければならない
    if (param.propertyType % 2n !== 0n) {
      throw new InvalidFilterError(`property type must be even: ${param.propertyType}`);
    }
    parts.push(encodeVarint(param.propertyType));
  }

  // Range 列（delta エンコーディング）
  let prevEnd = 0n;
  for (const [index, range] of param.ranges.entries()) {
    const startDelta = range.start - prevEnd;
    if (startDelta < 0n) {
      throw new Error("range start must be >= previous end");
    }
    // draft-ietf-moq-transport-21 §8.6:
    // "Any delta encoding that results in a value that exceeds 2^64-1
    //  MUST be rejected with REQUEST_ERROR with error code INVALID_FILTER."
    if (range.start > MAX_VARINT) {
      throw new InvalidFilterError(`range start exceeds maximum: ${range.start} > ${MAX_VARINT}`);
    }
    parts.push(encodeVarint(startDelta));

    if (range.end !== undefined) {
      const endDelta = range.end - range.start;
      if (endDelta < 0n) {
        throw new Error("range end must be >= range start");
      }
      if (range.end > MAX_VARINT) {
        throw new InvalidFilterError(`range end exceeds maximum: ${range.end} > ${MAX_VARINT}`);
      }
      parts.push(encodeVarint(endDelta));
      prevEnd = range.end;
    } else {
      // 末尾 Range のみ End 省略可
      if (index !== param.ranges.length - 1) {
        throw new Error("only the last range may omit end");
      }
    }
  }

  // draft-ietf-moq-transport-21 §9.20.13:
  // Publisher Priority は 8 bit のため、PRIORITY_FILTER の値は 255 以下でなければならない
  if (param.type === "priority") {
    for (const range of param.ranges) {
      if (range.start > 255n) {
        throw new InvalidFilterError(`priority filter value exceeds maximum: ${range.start} > 255`);
      }
      if (range.end !== undefined && range.end > 255n) {
        throw new InvalidFilterError(`priority filter value exceeds maximum: ${range.end} > 255`);
      }
    }
  }

  // Length フィールド (vi64) を先頭に付けて本体を連結する
  const body = concatUint8Arrays(parts);
  const lenBytes = encodeVarint(BigInt(body.length));
  return concatUint8Arrays([lenBytes, body]);
}

/**
 * Range Filter のワイヤデコード
 *
 * draft-ietf-moq-transport-21 Section 8.6:
 * 値域・構造の不正は InvalidFilterError で検出する (REQUEST_ERROR
 * (INVALID_FILTER) 応答または PROTOCOL_VIOLATION セッション閉鎖は
 * 受信経路の責務)。
 *
 * @returns [RangeFilterSpec, consumed bytes]
 */
export function decodeRangeFilter(
  type: "subgroup" | "objectId" | "priority" | "objectProperty" | "trackProperty",
  data: Uint8Array,
  offset = 0,
): [RangeFilterSpec, number] {
  const [length, lengthSize] = decodeVarint(data, offset);
  let totalConsumed = lengthSize;

  // Length = 0 は削除
  if (Number(length) === 0) {
    return [{ type, remove: true }, totalConsumed];
  }

  const bodyStart = offset + totalConsumed;
  const bodyEnd = bodyStart + Number(length);

  // 構造不正: Length > 0 なのに SetID が欠落
  if (bodyStart >= data.length) {
    throw new InvalidFilterError("range filter is missing SetID");
  }

  // SetID (8 bit)
  const setId = data[bodyStart];
  if (setId === undefined) {
    // 上の bodyStart >= data.length の検証で到達しない (型を絞るためのガード)
    throw new InvalidFilterError("range filter is missing SetID");
  }
  let pos = bodyStart + 1;

  // Property Type (vi64) - OBJECT_PROPERTY_FILTER / TRACK_PROPERTY_FILTER のみ
  let propertyType: bigint | undefined;
  if (type === "objectProperty" || type === "trackProperty") {
    // 構造不正: SetID のみで Property Type が欠落
    if (pos >= bodyEnd) {
      throw new InvalidFilterError("range filter is missing property type");
    }
    const [pt, ptSize] = decodeRangeFilterVarint(data, pos);
    // draft-ietf-moq-transport-21 §9.20.14 / §9.20.15:
    // Property Type は偶数でなければならない
    if (pt % 2n !== 0n) {
      throw new InvalidFilterError(`property type must be even: ${pt}`);
    }
    propertyType = pt;
    pos += ptSize;
  }

  // Range 列（delta デコーディング）
  const ranges: FilterRange[] = [];
  let prevEnd = 0n;
  while (pos < bodyEnd) {
    const [startDelta, startDeltaSize] = decodeRangeFilterVarint(data, pos);
    pos += startDeltaSize;
    const start = prevEnd + startDelta;

    // draft-ietf-moq-transport-21 §8.6:
    // "Any delta encoding that results in a value that exceeds 2^64-1
    //  MUST be rejected with REQUEST_ERROR with error code INVALID_FILTER."
    if (start > MAX_VARINT) {
      throw new InvalidFilterError(`range start exceeds maximum: ${start} > ${MAX_VARINT}`);
    }

    if (pos >= bodyEnd) {
      // 末尾 Range の End 省略（open-ended）
      ranges.push({ start });
      break;
    }

    const [endDelta, endDeltaSize] = decodeRangeFilterVarint(data, pos);
    pos += endDeltaSize;
    const end = start + endDelta;
    if (end > MAX_VARINT) {
      throw new InvalidFilterError(`range end exceeds maximum: ${end} > ${MAX_VARINT}`);
    }
    ranges.push({ start, end });
    prevEnd = end;
  }

  // 構造不正: Length > 0 なのに Range 列が欠落
  if (ranges.length === 0) {
    throw new InvalidFilterError("range filter has no ranges");
  }

  // draft-ietf-moq-transport-21 §9.20.13:
  // Publisher Priority は 8 bit のため、PRIORITY_FILTER の値は 255 以下でなければならない
  if (type === "priority") {
    for (const range of ranges) {
      if (range.start > 255n) {
        throw new InvalidFilterError(`priority filter value exceeds maximum: ${range.start} > 255`);
      }
      if (range.end !== undefined && range.end > 255n) {
        throw new InvalidFilterError(`priority filter value exceeds maximum: ${range.end} > 255`);
      }
    }
  }

  totalConsumed += Number(length);
  // exactOptionalPropertyTypes では optional な propertyType に undefined を渡せないため、
  // 値がある場合だけ載せた object を組み立てる
  const spec: RangeFilterSpec =
    propertyType === undefined ? { type, setId, ranges } : { type, setId, propertyType, ranges };
  return [spec, totalConsumed];
}

/**
 * Range Filter 内部の varint デコード
 *
 * draft-ietf-moq-transport-21 §8.6:
 * 宣言 Length 内で varint が途中終端するケース (構造不正) は、そのまま流すと
 * 受信ループの toProtocolViolationSessionError で PROTOCOL_VIOLATION の
 * セッション終了になるため、Range Filter の値違反として扱える
 * InvalidFilterError に変換する。REQUEST_UPDATE 経路ではこの値違反を
 * REQUEST_ERROR (INVALID_FILTER) で応答でき、PUBLISH_OK 経路では
 * REQUEST_ERROR を送信できないため PROTOCOL_VIOLATION でセッションを
 * 閉じる。
 */
function decodeRangeFilterVarint(data: Uint8Array, offset: number): [bigint, number] {
  try {
    return decodeVarint(data, offset);
  } catch (error) {
    if (error instanceof IncompleteDataError) {
      throw new InvalidFilterError("truncated varint in range filter");
    }
    throw error;
  }
}

/**
 * Range Filter パラメータの組み合わせ重複を検証する
 *
 * draft-ietf-moq-transport-21 §3.3.2:
 * "If the same combination of Parameter Type, SetID, and Property Type
 *  (only in the Track and Object Property Filters) repeat in any message,
 *  an endpoint MUST reject this with REQUEST_ERROR with error code
 *  INVALID_FILTER."
 *
 * Length=0 の削除エントリは SetID / Property Type を持たないため重複判定の対象外。
 * 違反時は InvalidFilterError を throw する。
 *
 * @param parameters - デコード済みのパラメータ配列
 */
export function validateRangeFilterCombination(parameters: Parameter[]): void {
  const seenCombinations = new Set<string>();
  for (const param of parameters) {
    if (param.type < 0x25 || param.type > 0x29) {
      continue;
    }
    const filterType = rangeFilterTypeOf(param.type);
    const [decoded] = decodeRangeFilter(filterType, param.value);
    if ("remove" in decoded) {
      continue;
    }
    // (Parameter Type, SetID, [Property Type]) の組み合わせキー
    const combinationKey = `${param.type}:${decoded.setId}:${decoded.propertyType ?? ""}`;
    if (seenCombinations.has(combinationKey)) {
      throw new InvalidFilterError(`duplicate range filter combination: ${combinationKey}`);
    }
    seenCombinations.add(combinationKey);
  }
}

/**
 * パラメータタイプ (0x25-0x29) から Range Filter の種別名を返す
 */
export function rangeFilterTypeOf(
  type: number,
): "subgroup" | "objectId" | "priority" | "objectProperty" | "trackProperty" {
  switch (type) {
    case 0x25:
      return "subgroup";
    case 0x26:
      return "objectId";
    case 0x27:
      return "priority";
    case 0x28:
      return "objectProperty";
    case 0x29:
      return "trackProperty";
    default:
      throw new InvalidFilterError(`unknown range filter parameter type: 0x${type.toString(16)}`);
  }
}
