/**
 * MOQ Log / MOQ Metrics の Group ID / Object ID gap 共通 helper
 *
 * log-04 §5.2 は前の Group からの差 - 1 を PRIOR_GROUP_ID_GAP、最大 Object ID + 1 を
 * End of Group とする。metrics-03 §5.4 は加えて skip した Object 数を
 * PRIOR_OBJECT_ID_GAP とする。log は Object ID が連続するため PRIOR_OBJECT_ID_GAP を
 * 使わない。検証と計算をここに集約し、各モジュールのラベルだけを変える。
 */

import { describeType } from "./observabilityCodec";
import { MAX_VARINT } from "./varint";

/**
 * 前の Group からの Prior Group ID Gap を計算する
 *
 * @param previousGroupId 前の Group ID（不明なら undefined）
 * @param currentGroupId 現在の Group ID
 * @param label エラー文言に使う対象名（例: "log" / "metrics"）
 * @throws Error 負数、vi64 の範囲外、増加しない Group ID の場合
 */
export function priorGroupIdGap(
  previousGroupId: bigint | undefined,
  currentGroupId: bigint,
  label: string,
): bigint | undefined {
  if (typeof currentGroupId !== "bigint") {
    throw new Error(`${label} group ID must be a bigint: ${describeType(currentGroupId)}`);
  }
  if (currentGroupId < 0n || currentGroupId > MAX_VARINT) {
    throw new Error(`${label} group ID must be 0..${MAX_VARINT}: ${currentGroupId}`);
  }
  if (previousGroupId === undefined) {
    return undefined;
  }
  if (typeof previousGroupId !== "bigint") {
    throw new Error(
      `previous ${label} group ID must be a bigint: ${describeType(previousGroupId)}`,
    );
  }
  if (previousGroupId < 0n || previousGroupId > MAX_VARINT) {
    throw new Error(`previous ${label} group ID must be 0..${MAX_VARINT}: ${previousGroupId}`);
  }
  if (currentGroupId <= previousGroupId) {
    throw new Error(
      `${label} group ID must increase: previous ${previousGroupId}, current ${currentGroupId}`,
    );
  }
  return currentGroupId - previousGroupId - 1n;
}

/**
 * skip された Object ID の Prior Object ID Gap を計算する
 *
 * @param previousObjectId 前の Object ID
 * @param currentObjectId 現在の Object ID
 * @param label エラー文言に使う対象名（例: "metrics"）
 * @throws Error 負数、vi64 の範囲外、増加しない Object ID の場合
 */
export function priorObjectIdGap(
  previousObjectId: bigint,
  currentObjectId: bigint,
  label: string,
): bigint | undefined {
  for (const [field, value] of [
    ["previous object ID", previousObjectId],
    ["object ID", currentObjectId],
  ] as const) {
    if (typeof value !== "bigint") {
      throw new Error(`${label} ${field} must be a bigint: ${describeType(value)}`);
    }
    if (value < 0n || value > MAX_VARINT) {
      throw new Error(`${label} ${field} must be 0..${MAX_VARINT}: ${value}`);
    }
  }
  if (currentObjectId <= previousObjectId) {
    throw new Error(
      `${label} object ID must increase: previous ${previousObjectId}, current ${currentObjectId}`,
    );
  }
  const gap = currentObjectId - previousObjectId - 1n;
  return gap === 0n ? undefined : gap;
}

/**
 * End of Group の Object ID を計算する
 *
 * @param largestObjectId 最大の Object ID
 * @param label エラー文言に使う対象名（例: "metrics"）
 * @throws Error 0..2^64-2 の範囲外の場合
 */
export function endOfGroupObjectId(largestObjectId: bigint, label: string): bigint {
  if (typeof largestObjectId !== "bigint") {
    throw new Error(
      `${label} largest object ID must be a bigint: ${describeType(largestObjectId)}`,
    );
  }
  if (largestObjectId < 0n || largestObjectId > MAX_VARINT - 1n) {
    throw new Error(`${label} largest object ID must be 0..${MAX_VARINT - 1n}: ${largestObjectId}`);
  }
  return largestObjectId + 1n;
}
