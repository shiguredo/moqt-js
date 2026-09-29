/**
 * c4m のテスト専用ヘルパー
 *
 * テストファイルと PBT ファイルの間で共有する。このファイルは vitest の
 * `test.include` (`src/**\/*.{test,prop}.ts`) に一致しない名前であり、テストを
 * 含まないファイルがテストファイルとして収集されるのを避ける。ライブラリの
 * ビルド entry (`src/index.ts`) からも到達しないため、配布物には含まれない。
 */

import { assert } from "vite-plus/test";
import { Base64DecodeError } from "./base64url";
import { CborError, type CborErrorCode } from "./cbor";
import { CoseError, type CoseErrorCode } from "./cose";
import { CryptoError, type CryptoErrorCode } from "./crypto";
import { C4mError, type C4mErrorCode } from "./moqt";
import {
  CatError,
  type CatErrorCode,
  ClaimValidationError,
  type ClaimValidationErrorCode,
} from "./cat";

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
 * CryptoError を期待してコードを検証する
 */
export function assertCryptoError(run: () => unknown, code: CryptoErrorCode): CryptoError {
  const error = captureThrownError(run);
  assert.ok(
    error instanceof CryptoError,
    `CryptoError を期待したが ${String(error)} が送出された (code=${code})`,
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
