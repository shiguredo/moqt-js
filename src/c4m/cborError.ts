/**
 * CBOR のエラーとネスト深度の上限
 *
 * `./cbor` の公開型を維持したまま、キーの重複判定を行う内部モジュール
 * (`./cborMapKeys`) からも参照できるように切り出したモジュールである。
 * `./index` からは re-export しない。
 */

import { unreachableValue } from "./unreachable";

/**
 * ネスト深度の上限
 *
 * デコード / エンコードの再帰呼び出しによるスタック枯渇を防ぐ。CWT / COSE / CAT が
 * 必要とする構造はこれより十分浅い。
 */
export const MAX_CBOR_DEPTH = 64;

/**
 * CBOR のエンコード / デコードエラー
 *
 * エラーコードと付随する数値 (additional information や単純値、長さなど) を
 * 保持する。
 */
export type CborErrorCode =
  | "unexpectedEof"
  | "invalidAdditionalInformation"
  | "invalidSimpleValue"
  | "invalidUtf8"
  | "breakOutsideIndefinite"
  | "invalidIndefiniteChunk"
  | "duplicateMapKey"
  | "depthLimitExceeded"
  | "lengthOverflow"
  | "invalidInteger"
  | "trailingBytes";

export class CborError extends Error {
  readonly code: CborErrorCode;
  readonly detail: number | undefined;

  constructor(code: CborErrorCode, detail?: number) {
    super(buildCborErrorMessage(code, detail));
    this.name = "CborError";
    this.code = code;
    this.detail = detail;
  }
}

/**
 * エラーコードから英語のメッセージを組み立てる
 */
function buildCborErrorMessage(code: CborErrorCode, detail?: number): string {
  switch (code) {
    case "unexpectedEof":
      return "unexpected end of input";
    case "invalidAdditionalInformation":
      return `invalid additional information: ${detail ?? 0}`;
    case "invalidSimpleValue":
      return `invalid simple value: ${detail ?? 0}`;
    case "invalidUtf8":
      return "text string is not valid UTF-8";
    case "breakOutsideIndefinite":
      return "break code outside of an indefinite-length item";
    case "invalidIndefiniteChunk":
      return "indefinite-length chunk has a different major type";
    case "duplicateMapKey":
      return "duplicate map key";
    case "depthLimitExceeded":
      return `nesting depth exceeds ${MAX_CBOR_DEPTH}`;
    case "lengthOverflow":
      return "length does not fit in a safe integer";
    case "invalidInteger":
      return detail === undefined ? "integer is out of range" : `invalid integer: ${detail}`;
    case "trailingBytes":
      return "trailing bytes after the data item";
    default:
      return unreachableValue(code);
  }
}
