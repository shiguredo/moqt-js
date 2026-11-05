/**
 * `moqt` / `moqt-reval` の claim label 設定の検証
 *
 * `./cat` から使う内部モジュールである。`./index` からは re-export しない。
 * エラーの型を `CatError` に依存させないため、検証結果を判別可能な型で返し、
 * 呼び出し側が CAT のエラーへ変換する。
 */

import type { C4mClaimLabels } from "./moqt";
import { MOQT_CLAIM_LABEL_KEYS, isReservedClaimLabel } from "./cwtClaimKeys";

/**
 * claim label 設定の検証結果
 */
type ClaimLabelsResolution =
  | { readonly ok: true; readonly labels: C4mClaimLabels }
  | { readonly ok: false; readonly message: string };

/**
 * claim label 設定を検証し、呼び出し元から独立したコピーを返す
 *
 * draft-ietf-moq-c4m-02 Section 8 は `moqt` / `moqt-reval` の claim key を
 * TBD のままにしており、暗黙の既定値は存在しない。次の設定は処理を始める前に
 * 拒否する。
 *
 * - 未指定、object 以外、配列、`moqt` / `moqtReval` が安全な整数でない値
 * - `moqt` と `moqtReval` が同じ値 (同じ key を 2 つの意味で使うため)
 * - IANA に登録済みの claim key との重複 (他の claim と区別できなくなるため)。
 *   ただし `moqtClaimLabelKeys` に含まれる key は、IANA が `moqt` /
 *   `moqt-reval` に割り当てた公式値として許可する
 *
 * `moqtClaimLabelKeys` は通常 `MOQT_CLAIM_LABEL_KEYS` を渡す。テストが IANA の
 * 将来の割当を模擬できるように引数で差し替えられるようにしている。
 *
 * 返す値は `Object.freeze` したコピーである。呼び出し元が設定元のオブジェクトを
 * 後から変更しても、Token / builder の解釈が変わらないようにするためである。
 */
export function resolveClaimLabels(
  claimLabels: C4mClaimLabels,
  moqtClaimLabelKeys: ReadonlySet<number> = MOQT_CLAIM_LABEL_KEYS,
): ClaimLabelsResolution {
  // TypeScript の型は実行時の値ではないため、未指定や object 以外も受け取り得る
  const candidate: unknown = claimLabels;
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
    return { ok: false, message: "claimLabels must be an object" };
  }
  const moqt: unknown = (candidate as { readonly moqt?: unknown }).moqt;
  const moqtReval: unknown = (candidate as { readonly moqtReval?: unknown }).moqtReval;
  // 安全な整数 (Number.isSafeInteger) だけを label として受理する。小数、NaN、
  // 無限大、2^53 以上の値は CBOR の整数として正確に往復できない
  if (typeof moqt !== "number" || !Number.isSafeInteger(moqt)) {
    return { ok: false, message: "claimLabels.moqt must be a safe integer" };
  }
  if (typeof moqtReval !== "number" || !Number.isSafeInteger(moqtReval)) {
    return { ok: false, message: "claimLabels.moqtReval must be a safe integer" };
  }
  if (moqt === moqtReval) {
    return {
      ok: false,
      message: "claimLabels.moqt and claimLabels.moqtReval must be different",
    };
  }
  if (isReservedClaimLabel(moqt, moqtClaimLabelKeys)) {
    return {
      ok: false,
      message: `claimLabels.moqt collides with an IANA registered claim key: ${moqt}`,
    };
  }
  if (isReservedClaimLabel(moqtReval, moqtClaimLabelKeys)) {
    return {
      ok: false,
      message: `claimLabels.moqtReval collides with an IANA registered claim key: ${moqtReval}`,
    };
  }
  return { ok: true, labels: Object.freeze({ moqt, moqtReval }) };
}
