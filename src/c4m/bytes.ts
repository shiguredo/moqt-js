/**
 * バイト列の比較 (c4m の内部ヘルパー)
 *
 * cbor と moqt が同じ実装を持っていたため、ここへ集約する。`c4m/index.ts` の
 * `export *` には含めない。内部専用のユーティリティであり、公開 API を増やさない
 * ためである (同じ扱いの `unreachable.ts` を参照)。
 */

/**
 * 2 つのバイト列が等しいかどうかを返す
 */
export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}
