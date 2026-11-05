/**
 * CBOR マップのキーの正規化と重複判定
 *
 * ワイヤ経路 (`./cbor`) と、`CborValue` を直接受ける公開 API (`./cat` / `./moqt`)
 * が同じ判定を使うための内部モジュールである。`./index` からは re-export しない。
 *
 * RFC 8949 Section 5.6.1 のとおり、キーの等価性はデータ項目の構造の比較ではなく、
 * 正規化したキーの決定論的エンコード (Section 4.2) のバイト列で判定する。これにより
 * `-0.0` と `0.0` は同じキーになり、NaN はすべて同じキーになる。
 *
 * 判定はキーをエンコードしたバイト列をソートして隣接比較する (O(n log n))。
 * 攻撃者入力の巨大なマップでも二次関数的な時間を使わない。
 */

import type { CborValue } from "./cbor";
import { assertCborDepth } from "./cborError";

/**
 * キーを決定論的エンコードしたバイト列を返す関数
 *
 * `CborError` を投げる実装を受け付ける。エンコードできないキーは比較の対象から
 * 除外せず、呼び出し側へエラーとして伝播する (fail-closed)。
 */
type CborKeyEncoder = (value: CborValue) => Uint8Array;

/**
 * バイト列を辞書順で比較する (決定論的エンコードの順序に使う)
 */
export function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return left.length - right.length;
}

/** 空のバイト列 (バイト列が無い場合の比較用) */
export const EMPTY_BYTES = new Uint8Array(0);

/**
 * 連番をバイト列の辞書順に並べ替えて返す
 */
export function sortedIndexes(keys: readonly Uint8Array[]): number[] {
  const order: number[] = [];
  for (let index = 0; index < keys.length; index++) {
    order.push(index);
  }
  order.sort((left, right) => compareBytes(keys[left] ?? EMPTY_BYTES, keys[right] ?? EMPTY_BYTES));
  return order;
}

/**
 * 重複キー検査用にキーを正規化する (RFC 8949 Section 5.6.1)
 *
 * `-0.0` と `0.0` は数値として等しいため同一のキーになる。NaN は実装判断として
 * すべて同一視する (safe side。仕様は significand が同じ NaN だけを等価とする)。
 * 深さ制限を超える場合は `CborError` (`depthLimitExceeded`) を投げる。
 */
export function normalizeCborKey(value: CborValue, depth: number): CborValue {
  assertCborDepth(depth);
  switch (value.type) {
    case "float":
      return value.value === 0 ? { type: "float", value: 0 } : value;
    case "array":
      return { type: "array", value: value.value.map((item) => normalizeCborKey(item, depth + 1)) };
    case "map":
      return {
        type: "map",
        value: value.value.map((entry) => [
          normalizeCborKey(entry[0], depth + 1),
          normalizeCborKey(entry[1], depth + 1),
        ]),
      };
    case "tag":
      return { type: "tag", tag: value.tag, value: normalizeCborKey(value.value, depth + 1) };
    default:
      return value;
  }
}

/**
 * 重複しているキーを 1 つ返す (重複が無ければ undefined)
 *
 * キーを正規化してから決定論的エンコードのバイト列へ変換し、ソートして隣接比較
 * する。返す値は入力のキーそのもので、エラーの詳細に使える。
 *
 * 深さ上限の超過や bool を表す simple value 20 などでエンコードできないキーは、
 * 比較の対象から外さず `CborError` として伝播する。黙って除外すると、手組みの
 * `CborValue` で同じキーの重複が検査をすり抜け、後から来た値を返す fail-open に
 * なるためである。ワイヤ経路ではデコード済みのキーが必ずエンコードできるが、
 * この関数は `CborValue` を直接受ける公開 API からも使われる。呼び出し側は
 * キーの型を事前に検証するか、このエラーを拒否として扱うこと。
 */
export function findDuplicateMapKey(
  entries: Array<[CborValue, CborValue]>,
  encodeKey: CborKeyEncoder,
): CborValue | undefined {
  const keys: CborValue[] = [];
  const encodedKeys: Uint8Array[] = [];
  for (const [key] of entries) {
    const encoded = encodeKey(normalizeCborKey(key, 0));
    keys.push(key);
    encodedKeys.push(encoded);
  }
  const order = sortedIndexes(encodedKeys);
  for (let index = 1; index < order.length; index++) {
    const previous = encodedKeys[order[index - 1] ?? 0] ?? EMPTY_BYTES;
    const current = encodedKeys[order[index] ?? 0] ?? EMPTY_BYTES;
    if (compareBytes(previous, current) === 0) {
      const duplicateIndex = order[index];
      return duplicateIndex !== undefined ? keys[duplicateIndex] : undefined;
    }
  }
  return undefined;
}

/**
 * マップのキーが重複しているかどうかを判定する
 *
 * ワイヤ経路のデコードで使う。判定は `findDuplicateMapKey` と同じである。
 */
export function hasDuplicateMapKeys(
  entries: Array<[CborValue, CborValue]>,
  encodeKey: CborKeyEncoder,
): boolean {
  return findDuplicateMapKey(entries, encodeKey) !== undefined;
}
