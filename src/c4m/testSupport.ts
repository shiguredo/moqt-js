/**
 * c4m のテスト専用ヘルパー
 *
 * テストファイルと PBT ファイルの間で共有する。このファイルは vitest の
 * `test.include` (`src/**\/*.{test,prop}.ts`) に一致しない名前であり、テストを
 * 含まないファイルがテストファイルとして収集されるのを避ける。ライブラリの
 * ビルド entry (`src/index.ts`) からも到達しないため、配布物には含まれない。
 */

import { assert } from "vite-plus/test";
import * as fc from "fast-check";
import { Base64DecodeError } from "./base64url";
import {
  CBOR_FALSE,
  CBOR_NULL,
  CBOR_TRUE,
  CBOR_UNDEFINED,
  type CborValue,
  CborError,
  type CborErrorCode,
  cborArray,
  cborByteString,
  cborFloat,
  cborMap,
  cborNegative,
  cborSimple,
  cborTag,
  cborTextString,
  cborUnsigned,
} from "./cbor";
import { CoseError, type CoseErrorCode } from "./cose";
import { C4mError, type C4mErrorCode } from "./moqt";
import {
  CatError,
  type CatErrorCode,
  ClaimValidationError,
  type ClaimValidationErrorCode,
} from "./cat";
import { JwkError, type JwkErrorCode } from "./jwk";

/**
 * 16 進文字列をバイト列へ変換する
 *
 * `tests/test_c4m/helpers.rs` の decode_hex と同じ用途で、テストベクタの
 * 16 進表記をそのまま固定するために使う。
 */
export function decodeHex(text: string): Uint8Array {
  if (text.length % 2 !== 0) {
    throw new Error(`hex string must have an even length: ${text.length}`);
  }
  const bytes = new Uint8Array(text.length / 2);
  for (let index = 0; index < bytes.length; index++) {
    const byte = Number.parseInt(text.slice(index * 2, index * 2 + 2), 16);
    if (Number.isNaN(byte)) {
      throw new Error(`invalid hex string: ${text}`);
    }
    bytes[index] = byte;
  }
  return bytes;
}

/**
 * バイト列を 16 進文字列へ変換する
 */
export function encodeHex(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) {
    text += byte.toString(16).padStart(2, "0");
  }
  return text;
}

/**
 * 例外を捕捉して返す
 */
export function captureThrownError(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

/**
 * 非同期処理の例外を捕捉して返す
 */
export async function captureRejectedError(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  return undefined;
}

/**
 * CborError を期待してコードと付随値を検証する
 */
export function assertCborError(
  run: () => unknown,
  code: CborErrorCode,
  detail?: number,
): CborError {
  const error = captureThrownError(run);
  assert.ok(
    error instanceof CborError,
    `CborError を期待したが ${String(error)} が送出された (code=${code})`,
  );
  assert.equal(error.code, code);
  if (detail !== undefined) {
    assert.equal(error.detail, detail);
  }
  return error;
}

/**
 * Base64DecodeError を期待する
 */
export function assertBase64Error(run: () => unknown): Base64DecodeError {
  const error = captureThrownError(run);
  assert.ok(
    error instanceof Base64DecodeError,
    `Base64DecodeError を期待したが ${String(error)} が送出された`,
  );
  return error;
}

/**
 * CoseError を期待してコードと付随値を検証する
 */
export function assertCoseError(
  run: () => unknown,
  code: CoseErrorCode,
  detail?: string | number | bigint,
): CoseError {
  const error = captureThrownError(run);
  assert.ok(
    error instanceof CoseError,
    `CoseError を期待したが ${String(error)} が送出された (code=${code})`,
  );
  assert.equal(error.code, code);
  if (detail !== undefined) {
    assert.equal(error.detail, detail);
  }
  return error;
}

/**
 * CatError を期待してコードと付随値を検証する
 */
export function assertCatError(
  run: () => unknown,
  code: CatErrorCode,
  detail?: string | number | bigint,
): CatError {
  const error = captureThrownError(run);
  assert.ok(
    error instanceof CatError,
    `CatError を期待したが ${String(error)} が送出された (code=${code})`,
  );
  assert.equal(error.code, code);
  if (detail !== undefined) {
    assert.equal(error.detail, detail);
  }
  return error;
}

/**
 * C4mError を期待してコードと付随値を検証する
 */
export function assertC4mError(
  run: () => unknown,
  code: C4mErrorCode,
  detail?: string | number,
): C4mError {
  const error = captureThrownError(run);
  assert.ok(
    error instanceof C4mError,
    `C4mError を期待したが ${String(error)} が送出された (code=${code})`,
  );
  assert.equal(error.code, code);
  if (detail !== undefined) {
    assert.equal(error.detail, detail);
  }
  return error;
}

/**
 * ClaimValidationError を期待してコードを検証する
 */
export function assertClaimValidationError(
  run: () => unknown,
  code: ClaimValidationErrorCode,
): ClaimValidationError {
  const error = captureThrownError(run);
  assert.ok(
    error instanceof ClaimValidationError,
    `ClaimValidationError を期待したが ${String(error)} が送出された (code=${code})`,
  );
  assert.equal(error.code, code);
  return error;
}

/**
 * JwkError を期待してコードを検証する
 */
export function assertJwkError(run: () => unknown, code: JwkErrorCode): JwkError {
  const error = captureThrownError(run);
  assert.ok(
    error instanceof JwkError,
    `JwkError を期待したが ${String(error)} が送出された (code=${code})`,
  );
  assert.equal(error.code, code);
  return error;
}

/**
 * 標準 Base64 (RFC 4648 Section 4) でエンコードする (テストの入力生成用)
 *
 * ライブラリ本体は URL 埋め込みの検証のために標準 Base64 のデコードだけを
 * 提供する。テストではパディングあり / なしの入力を生成する必要がある。
 */
export function encodeBase64Standard(bytes: Uint8Array, padded: boolean): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let result = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1] ?? 0;
    const third = bytes[index + 2] ?? 0;
    const remaining = bytes.length - index;
    const chunk = (first << 16) | (second << 8) | third;
    result += alphabet.charAt((chunk >> 18) & 0x3f);
    result += alphabet.charAt((chunk >> 12) & 0x3f);
    if (remaining > 1) {
      result += alphabet.charAt((chunk >> 6) & 0x3f);
    }
    if (remaining > 2) {
      result += alphabet.charAt(chunk & 0x3f);
    }
  }
  if (padded) {
    while (result.length % 4 !== 0) {
      result += "=";
    }
  }
  return result;
}

/**
 * 整数のヘッド長が変わる境界 (RFC 8949 Section 3)
 *
 * 0〜23 は 1 バイトで完結し、24 / 25 / 26 / 27 はそれぞれ 1 / 2 / 4 / 8 バイトの
 * 引数を伴う。境界を含めないと、生成器の分布 (fast-check の bigInt は範囲の両端に
 * 偏る) では 1 バイトと 8 バイトのヘッドしか踏まない。
 */
const CBOR_INTEGER_BOUNDARIES: readonly bigint[] = [
  0n,
  23n,
  24n,
  255n,
  256n,
  65535n,
  65536n,
  4294967295n,
  4294967296n,
  9223372036854775807n,
  9223372036854775808n,
  18446744073709551615n,
];

/**
 * タグのヘッド長が変わる境界 (RFC 8949 Section 3)
 *
 * COSE / CWT が使うタグ (17 / 18 / 61) も含める。
 */
const CBOR_TAG_BOUNDARIES: readonly bigint[] = [0n, 17n, 18n, 23n, 24n, 61n, 255n, 256n, 65536n];

/**
 * 浮動小数点数の境界 (RFC 8949 Section 4.2.1 / Section 4.2.2)
 *
 * 半精度 / 単精度 / 倍精度で表現が変わる値と、符号付きゼロ・非数・無限大を含める。
 */
const CBOR_FLOAT_BOUNDARIES: readonly number[] = [
  0,
  -0,
  1,
  1.5,
  -1.5,
  65504,
  65505,
  2 ** -24,
  2 ** -25,
  2 ** -14,
  1e300,
  Number.MIN_VALUE,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
];

/**
 * CBOR のデータ項目を生成する Arbitrary
 *
 * cbor / cose / cat / moqt の各 PBT が共有する。`depth` は入れ子の上限である。
 *
 * - マップのキーは重複しない符号なし整数にし、決定論的エンコードの順序 (キーの
 *   エンコード済みバイト列の昇順) に並べておく。並べないと、デコードが返す順序と
 *   生成した値の順序が食い違い、往復の比較が値の違いではなく順序の違いで落ちる
 * - テキスト文字列は grapheme 単位で生成し、UTF-8 として不正な文字列を含めない
 * - `size: "max"` を指定する。fast-check の既定 (`small`) は `maxLength` を 10 に
 *   切り捨てるため、長い文字列や配列のヘッド (3 / 5 バイト) に到達しない
 */
export function cborValueArbitrary(depth: number): fc.Arbitrary<CborValue> {
  const integerArbitrary = fc.oneof(
    fc.bigInt({ min: 0n, max: 18446744073709551615n }),
    fc.constantFrom(...CBOR_INTEGER_BOUNDARIES),
  );
  const leaf = fc.oneof(
    integerArbitrary.map((value) => cborUnsigned(value)),
    integerArbitrary.map((value) => cborNegative(value)),
    fc.uint8Array({ maxLength: 24, size: "max" }).map((value) => cborByteString(value)),
    fc
      .string({ unit: "grapheme", maxLength: 24, size: "max" })
      .map((value) => cborTextString(value)),
    fc.double().map((value) => cborFloat(value)),
    fc.constantFrom(...CBOR_FLOAT_BOUNDARIES).map((value) => cborFloat(value)),
    fc.constantFrom(CBOR_NULL, CBOR_UNDEFINED, CBOR_TRUE, CBOR_FALSE),
    fc.oneof(
      fc.integer({ min: 0, max: 19 }).map((value) => cborSimple(value)),
      fc.integer({ min: 32, max: 255 }).map((value) => cborSimple(value)),
    ),
  );
  if (depth <= 0) {
    return leaf;
  }
  const arrayArbitrary = fc
    .array(cborValueArbitrary(depth - 1), { maxLength: 3, size: "max" })
    .map((items) => cborArray(items));
  const mapArbitrary = fc
    .uniqueArray(fc.tuple(fc.bigInt({ min: 0n, max: 1000n }), cborValueArbitrary(depth - 1)), {
      selector: (entry) => entry[0].toString(),
      maxLength: 3,
      size: "max",
    })
    .map((entries) => {
      const sorted = entries
        .slice()
        .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0))
        .map(([key, value]) => [cborUnsigned(key), value] as [CborValue, CborValue]);
      return cborMap(sorted);
    });
  const tagArbitrary = fc
    .tuple(fc.constantFrom(...CBOR_TAG_BOUNDARIES), cborValueArbitrary(depth - 1))
    .map(([tag, value]) => cborTag(tag, value));
  return fc.oneof(
    { weight: 4, arbitrary: leaf },
    { weight: 1, arbitrary: arrayArbitrary },
    { weight: 1, arbitrary: mapArbitrary },
    { weight: 1, arbitrary: tagArbitrary },
  );
}
