/**
 * Uint8Array 連結の共通ヘルパー
 *
 * MOQT のエンコーダは「ワイヤフォーマットのフィールド順に Uint8Array を
 * 配列へ積み、最後に 1 つの Uint8Array へ連結する」パターンを繰り返す。
 * 連結処理 (合計長の算出 → 1 回の領域確保 → 順次 set) をここに集約する。
 *
 * draft-ietf-moq-transport-21: 各メッセージのエンコーディングは
 * Section 9 (Control Messages) / Section 11 (Data Streams and Datagrams) が
 * 個別に定義する。本モジュールはバイト列の連結のみを担い、値の解釈はしない。
 * 節番号は仕様将来版で変わる可能性がある。
 */

/**
 * Uint8Array の配列を 1 つの Uint8Array に連結する
 *
 * 要素数 0 の場合は長さ 0 の Uint8Array を返す。各要素の内容はコピーされる
 * (呼び出し側が渡した配列を後から変更しても結果は変わらない)。
 *
 * @param arrays - 連結するバイト列 (この順序で連結する)
 * @returns 連結後のバイト列
 */
export function concatUint8Arrays(arrays: Uint8Array[]): Uint8Array {
  const totalLength = arrays.reduce((sum, array) => sum + array.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const array of arrays) {
    result.set(array, offset);
    offset += array.length;
  }
  return result;
}
