/**
 * IANA の CWT Claims レジストリに由来する claim key
 *
 * `./claimLabels` の内部で使うモジュールである。`./index` からは re-export しない。
 * 一覧はレジストリの整数 key をそのまま持ち、`moqt` / `moqt-reval` の label との
 * 衝突判定に使う。
 */

/**
 * IANA の CWT Claims レジストリに登録済みの claim key
 *
 * 出典: IANA CWT Claims registry、2026-11-05 確認、XML より
 * https://www.iana.org/assignments/cwt/cwt.xml
 *
 * RFC 8392 Section 9.1 の初期登録と、その後に登録された CTA-5007 の CAT の
 * claim (308〜323)、CTA-5009 の geohash (282)、EAT の claim などを含む、
 * 登録済みの整数 key 76 件の一覧である。
 *
 * 0 は RFC 8392 Section 9.1.2 が RESERVED として予約しており、claim key として
 * 使えない。`moqt` / `moqt-reval` の label にも claim set の key にもできない
 * (claim set での拒否は `decodeCatClaims` を参照)。
 *
 * 2397 は Unassigned である。RFC 9783 の PSA claims は 2394〜2396 と
 * 2398〜2400 に登録されており、2397 を間に挟んでいる。
 *
 * レジストリに登録が追加されると、その key を `moqt` / `moqt-reval` の label に
 * 使ったときに本来の claim と区別できなくなる。将来の登録追加に追随してこの
 * 一覧も更新すること。ただし IANA が `moqt` / `moqt-reval` に値を割り当てた
 * 場合は `MOQT_CLAIM_LABEL_KEYS` に追加し、その値だけは label として許可する。
 */
export const IANA_CWT_CLAIM_KEYS: readonly number[] = Object.freeze([
  -261, -260, -259, -258, -257, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 38, 39, 40, 169, 256, 257,
  258, 259, 260, 261, 262, 263, 264, 265, 266, 267, 268, 269, 270, 271, 272, 273, 274, 275, 282,
  299, 300, 301, 302, 303, 304, 305, 306, 307, 308, 309, 310, 311, 312, 313, 314, 315, 316, 317,
  318, 319, 320, 321, 322, 323, 2394, 2395, 2396, 2398, 2399, 2400, 65533, 65534, 65535,
]);

/**
 * IANA の CWT Claims レジストリに登録済みの claim key の集合
 */
export const IANA_CWT_CLAIM_KEY_SET: ReadonlySet<number> = new Set(IANA_CWT_CLAIM_KEYS);

/**
 * `moqt` / `moqt-reval` に割り当てられた claim key
 *
 * IANA が `moqt` / `moqt-reval` の公式値を CWT Claims レジストリへ割り当てたら、
 * この集合へ追加する。追加するまでは、登録済みの key を label に使うと本来の
 * claim と区別できなくなるため拒否する。
 *
 * 現時点では空である。draft-ietf-moq-c4m-02 Section 8 は両 claim の key を
 * TBD_MOQT / TBD_MOQT_REVAL のままにしており、IANA に割り当てられていない。
 */
export const MOQT_CLAIM_LABEL_KEYS: ReadonlySet<number> = new Set<number>();

/**
 * IANA 登録済み key のうち、`moqt` / `moqt-reval` の label として使えない key か
 * どうかを返す
 *
 * `moqtClaimLabelKeys` は通常 `MOQT_CLAIM_LABEL_KEYS` を渡す。テストが IANA の
 * 将来の割当を模擬できるように引数で差し替えられるようにしている。
 */
export function isReservedClaimLabel(
  key: number,
  moqtClaimLabelKeys: ReadonlySet<number>,
): boolean {
  return IANA_CWT_CLAIM_KEY_SET.has(key) && !moqtClaimLabelKeys.has(key);
}
