/**
 * CBOR (Concise Binary Object Representation) のコーデック
 *
 * RFC 8949 のデータ項目をエンコード / デコードする。CWT / COSE / CAT
 * (draft-ietf-moq-c4m-01) が必要とする範囲を対象とし、エンコードは RFC 8949
 * Section 4.2 の決定論的エンコード (Deterministically Encoded CBOR) に従う。
 *
 * - 整数と長さは最小の長さでエンコードする
 * - マップのキーはキーのエンコード済みバイト列の昇順に並べる (Section 4.2.1)
 * - 浮動小数点数は値を保つ最短の幅 (半精度 / 単精度 / 倍精度) を使い、NaN は
 *   `f9 7e 00` にする (Section 4.2.1 / Section 4.2.2)
 * - デコードは definite / indefinite の両方の長さ表現を受理する。マップの重複キー、
 *   UTF-8 でないテキスト文字列、ネスト深度の上限超過はエラーにする
 *
 * 64 ビットの符号なし整数は number では正確に表せないため bigint を使う。
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
 * CBOR のデータ項目 (RFC 8949 Section 3)
 *
 * 符号なし整数と負の整数は major type が異なる別のデータ項目のため、値が同じでも
 * 表現を保つように分けて持つ (`cborInteger` は値の符号で振り分ける)。
 */
export type CborValue =
  | { readonly type: "unsigned"; readonly value: bigint }
  | { readonly type: "negative"; readonly value: bigint }
  | { readonly type: "byteString"; readonly value: Uint8Array }
  | { readonly type: "textString"; readonly value: string }
  | { readonly type: "array"; readonly value: CborValue[] }
  | { readonly type: "map"; readonly value: Array<[CborValue, CborValue]> }
  | { readonly type: "tag"; readonly tag: bigint; readonly value: CborValue }
  | { readonly type: "bool"; readonly value: boolean }
  | { readonly type: "null" }
  | { readonly type: "undefined" }
  | { readonly type: "float"; readonly value: number }
  | { readonly type: "simple"; readonly value: number };

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
    case "trailingBytes":
      return "trailing bytes after the data item";
    default:
      return unreachableValue(code);
  }
}

/**
 * 値の符号から整数のデータ項目を作る
 *
 * @param value - エンコードする整数 (number / bigint)
 */
export function cborInteger(value: bigint | number): CborValue {
  const integer = BigInt(value);
  if (integer >= 0n) {
    return { type: "unsigned", value: integer };
  }
  // major type 1 の値は `-1 - n` で表す (RFC 8949 Section 3.1)
  return { type: "negative", value: -1n - integer };
}

/**
 * 符号なし整数のデータ項目を作る (major type 0)
 */
export function cborUnsigned(value: bigint): CborValue {
  return { type: "unsigned", value };
}

/**
 * 負の整数のデータ項目を作る (major type 1)
 *
 * `value` は `-1 - n` の `n` (0 以上) を表す。
 */
export function cborNegative(value: bigint): CborValue {
  return { type: "negative", value };
}

/**
 * バイト文字列のデータ項目を作る (major type 2)
 */
export function cborByteString(value: Uint8Array): CborValue {
  return { type: "byteString", value };
}

/**
 * テキスト文字列のデータ項目を作る (major type 3)
 */
export function cborTextString(value: string): CborValue {
  return { type: "textString", value };
}

/**
 * 配列のデータ項目を作る (major type 4)
 */
export function cborArray(value: CborValue[]): CborValue {
  return { type: "array", value };
}

/**
 * マップのデータ項目を作る (major type 5)
 *
 * エンコード時はキーの決定論的順序に並べ替える。デコード時は入力の順序を保つ。
 */
export function cborMap(value: Array<[CborValue, CborValue]>): CborValue {
  return { type: "map", value };
}

/**
 * タグ付きデータ項目を作る (major type 6)
 */
export function cborTag(tag: bigint | number, value: CborValue): CborValue {
  return { type: "tag", tag: BigInt(tag), value };
}

/**
 * 真偽値のデータ項目を作る (major type 7 の 20 / 21)
 */
export function cborBool(value: boolean): CborValue {
  return { type: "bool", value };
}

/**
 * 浮動小数点数のデータ項目を作る (major type 7 の 25 / 26 / 27)
 */
export function cborFloat(value: number): CborValue {
  return { type: "float", value };
}

/**
 * 上記以外の単純値のデータ項目を作る (major type 7 の 0 〜 19 と 32 〜 255)
 */
export function cborSimple(value: number): CborValue {
  return { type: "simple", value };
}

/** null (major type 7 の 22) */
export const CBOR_NULL: CborValue = { type: "null" };

/** undefined (major type 7 の 23) */
export const CBOR_UNDEFINED: CborValue = { type: "undefined" };

/** 真 (major type 7 の 21) */
export const CBOR_TRUE: CborValue = { type: "bool", value: true };

/** 偽 (major type 7 の 20) */
export const CBOR_FALSE: CborValue = { type: "bool", value: false };

/**
 * マップからキーに対応する値を取り出す
 *
 * マップ以外では常に undefined を返す。キーの等価比較はデータ項目の構造比較で行う。
 *
 * @param value - 対象のデータ項目
 * @param key - 探すキー
 */
export function cborMapGet(value: CborValue, key: CborValue): CborValue | undefined {
  if (value.type !== "map") {
    return undefined;
  }
  for (const entry of value.value) {
    if (cborEquals(entry[0], key)) {
      return entry[1];
    }
  }
  return undefined;
}

/**
 * 符号なし整数として取り出す (major type 0 のみ)
 */
export function cborAsUnsigned(value: CborValue): bigint | undefined {
  return value.type === "unsigned" ? value.value : undefined;
}

/**
 * 整数として取り出す (major type 0 / 1)
 */
export function cborAsInteger(value: CborValue): bigint | undefined {
  switch (value.type) {
    case "unsigned":
      return value.value;
    case "negative":
      return -1n - value.value;
    default:
      return undefined;
  }
}

/**
 * 64 ビット符号付き整数の範囲 (COSE / CWT / CAT の整数フィールドの前提)
 */
const MIN_INT64 = -9_223_372_036_854_775_808n;
const MAX_INT64 = 9_223_372_036_854_775_807n;

/**
 * 64 ビット符号付き整数の範囲に収まる整数として取り出す
 *
 * COSE / CWT / CAT の整数フィールドは i64 を前提とするため、範囲外の
 * 符号なし整数は整数として扱わない。
 */
export function cborAsInt64(value: CborValue): bigint | undefined {
  const integer = cborAsInteger(value);
  if (integer === undefined) {
    return undefined;
  }
  if (integer < MIN_INT64 || integer > MAX_INT64) {
    return undefined;
  }
  return integer;
}

/**
 * 整数または浮動小数点数の数値として取り出す
 *
 * 整数は 1 回だけ丸めて number へ変換する。CBOR の整数は 64 ビットまであり、
 * number では 2^53 を超える値が正確に表せないため、bigint から直接変換して
 * 二重丸めを避ける。
 */
export function cborAsNumber(value: CborValue): number | undefined {
  switch (value.type) {
    case "unsigned":
      return Number(value.value);
    case "negative":
      return Number(-1n - value.value);
    case "float":
      return value.value;
    default:
      return undefined;
  }
}

/**
 * バイト文字列として取り出す (major type 2)
 */
export function cborAsBytes(value: CborValue): Uint8Array | undefined {
  return value.type === "byteString" ? value.value : undefined;
}

/**
 * テキスト文字列として取り出す (major type 3)
 */
export function cborAsText(value: CborValue): string | undefined {
  return value.type === "textString" ? value.value : undefined;
}

/**
 * 配列として取り出す (major type 4)
 */
export function cborAsArray(value: CborValue): CborValue[] | undefined {
  return value.type === "array" ? value.value : undefined;
}

/**
 * マップとして取り出す (major type 5)
 */
export function cborAsMap(value: CborValue): Array<[CborValue, CborValue]> | undefined {
  return value.type === "map" ? value.value : undefined;
}

/**
 * 真偽値として取り出す (major type 7 の 20 / 21)
 */
export function cborAsBool(value: CborValue): boolean | undefined {
  return value.type === "bool" ? value.value : undefined;
}

/**
 * 2 つのデータ項目が同じ構造かどうかを返す
 *
 * CBOR のデータ項目としての等価性 (major type の違いも区別する) を比較する。
 * 数値としての等価性 (-0.0 と 0.0 など) は `normalizeCborKey` で正規化してから
 * 比較する。
 */
export function cborEquals(left: CborValue, right: CborValue): boolean {
  switch (left.type) {
    case "unsigned":
    case "negative":
      return right.type === left.type && right.value === left.value;
    case "byteString":
      return right.type === "byteString" && bytesEqual(left.value, right.value);
    case "textString":
      return right.type === "textString" && right.value === left.value;
    case "array":
      return (
        right.type === "array" &&
        left.value.length === right.value.length &&
        left.value.every((item, index) => cborEquals(item, right.value[index] ?? CBOR_UNDEFINED))
      );
    case "map":
      return (
        right.type === "map" &&
        left.value.length === right.value.length &&
        left.value.every((entry, index) => {
          const other = right.value[index];
          return (
            other !== undefined && cborEquals(entry[0], other[0]) && cborEquals(entry[1], other[1])
          );
        })
      );
    case "tag":
      return right.type === "tag" && right.tag === left.tag && cborEquals(left.value, right.value);
    case "bool":
      return right.type === "bool" && right.value === left.value;
    case "null":
      return right.type === "null";
    case "undefined":
      return right.type === "undefined";
    case "float":
      // CBOR のデータ項目としての等価性は f64 の == と同じ
      // (-0.0 と 0.0 は等しく、NaN は等しくない)
      return right.type === "float" && left.value === right.value;
    case "simple":
      return right.type === "simple" && right.value === left.value;
    default:
      return unreachableValue(left);
  }
}

/**
 * 2 つのバイト列が等しいかどうかを返す
 */
function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
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

/**
 * バイト列を辞書順で比較する (決定論的エンコードの順序に使う)
 */
function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return left.length - right.length;
}

/**
 * CBOR のデータ項目をエンコードする
 *
 * RFC 8949 Section 4.2 の決定論的エンコードに従う。マップに重複するキーがある場合は
 * `duplicateMapKey` で失敗する。
 *
 * @param value - エンコードするデータ項目
 * @returns エンコードしたバイト列
 */
export function encodeCbor(value: CborValue): Uint8Array {
  const output: number[] = [];
  encodeCborValue(value, 0, output);
  return new Uint8Array(output);
}

/**
 * CBOR のデータ項目をデコードする
 *
 * 入力の全バイトをデータ項目として消費する。末尾に余分なバイトがある場合は
 * `trailingBytes` で失敗する。
 *
 * @param bytes - デコードするバイト列
 * @returns デコードしたデータ項目
 */
export function decodeCbor(bytes: Uint8Array): CborValue {
  const { value, consumed } = decodeCborPartial(bytes);
  if (consumed !== bytes.length) {
    throw new CborError("trailingBytes");
  }
  return value;
}

/**
 * CBOR のデータ項目をデコードし、消費したバイト数を返す
 *
 * @param bytes - デコードするバイト列
 * @returns デコードしたデータ項目と消費したバイト数
 */
export function decodeCborPartial(bytes: Uint8Array): { value: CborValue; consumed: number } {
  const decoder = new CborDecoder(bytes);
  const value = decoder.decodeValue(0);
  return { value, consumed: decoder.position };
}

/**
 * ネスト深度の上限を超えているかどうかを返す
 */
function checkDepth(depth: number): void {
  if (depth > MAX_CBOR_DEPTH) {
    throw new CborError("depthLimitExceeded");
  }
}

/**
 * 数値を最小の長さでエンコードする (RFC 8949 Section 3)
 */
function writeHead(major: number, value: bigint, output: number[]): void {
  const prefix = major << 5;
  if (value < 24n) {
    output.push(prefix | Number(value));
    return;
  }
  if (value <= 0xffn) {
    output.push(prefix | 24);
    output.push(Number(value));
    return;
  }
  if (value <= 0xffffn) {
    output.push(prefix | 25);
    output.push(Number(value >> 8n), Number(value & 0xffn));
    return;
  }
  if (value <= 0xffffffffn) {
    output.push(prefix | 26);
    output.push(
      Number((value >> 24n) & 0xffn),
      Number((value >> 16n) & 0xffn),
      Number((value >> 8n) & 0xffn),
      Number(value & 0xffn),
    );
    return;
  }
  output.push(prefix | 27);
  for (let shift = 56n; shift >= 0n; shift -= 8n) {
    output.push(Number((value >> shift) & 0xffn));
  }
}

/**
 * データ項目をエンコードして出力配列へ追記する
 */
function encodeCborValue(value: CborValue, depth: number, output: number[]): void {
  checkDepth(depth);
  switch (value.type) {
    case "unsigned":
      writeHead(0, value.value, output);
      return;
    case "negative":
      writeHead(1, value.value, output);
      return;
    case "byteString": {
      writeHead(2, BigInt(value.value.length), output);
      for (const byte of value.value) {
        output.push(byte);
      }
      return;
    }
    case "textString": {
      const encoded = TEXT_ENCODER.encode(value.value);
      writeHead(3, BigInt(encoded.length), output);
      for (const byte of encoded) {
        output.push(byte);
      }
      return;
    }
    case "array": {
      writeHead(4, BigInt(value.value.length), output);
      for (const item of value.value) {
        encodeCborValue(item, depth + 1, output);
      }
      return;
    }
    case "map": {
      encodeCborMap(value.value, depth, output);
      return;
    }
    case "tag":
      writeHead(6, value.tag, output);
      encodeCborValue(value.value, depth + 1, output);
      return;
    case "bool":
      output.push(value.value ? 0xf5 : 0xf4);
      return;
    case "null":
      output.push(0xf6);
      return;
    case "undefined":
      output.push(0xf7);
      return;
    case "float":
      encodeFloat(value.value, output);
      return;
    case "simple":
      if (value.value <= 19) {
        output.push(0xe0 | value.value);
        return;
      }
      if (value.value <= 31) {
        // RFC 8949 Section 3.3: 20 〜 31 は予約されており、単純値として使えない
        throw new CborError("invalidSimpleValue", value.value);
      }
      output.push(0xf8, value.value);
  }
}

/**
 * マップを決定論的エンコードで出力する
 *
 * キーのエンコード済みバイト列の昇順に並べる (RFC 8949 Section 4.2.1)。同じ
 * エンコード済みバイト列のキーが 2 つある場合は重複キーとして拒否する。
 */
function encodeCborMap(
  entries: Array<[CborValue, CborValue]>,
  depth: number,
  output: number[],
): void {
  const encodedKeys: Uint8Array[] = [];
  for (const entry of entries) {
    // -0.0 と 0.0 は同一のキーとして扱う (RFC 8949 Section 5.6.1)
    const normalized = normalizeCborKey(entry[0], depth + 1);
    const keyOutput: number[] = [];
    encodeCborValue(normalized, depth + 1, keyOutput);
    encodedKeys.push(new Uint8Array(keyOutput));
  }
  const order: number[] = [];
  for (let index = 0; index < entries.length; index++) {
    order.push(index);
  }
  order.sort((left, right) =>
    compareBytes(encodedKeys[left] ?? EMPTY_BYTES, encodedKeys[right] ?? EMPTY_BYTES),
  );
  for (let index = 1; index < order.length; index++) {
    const previous = encodedKeys[order[index - 1] ?? 0] ?? EMPTY_BYTES;
    const current = encodedKeys[order[index] ?? 0] ?? EMPTY_BYTES;
    if (compareBytes(previous, current) === 0) {
      throw new CborError("duplicateMapKey");
    }
  }
  writeHead(5, BigInt(entries.length), output);
  for (const index of order) {
    const key = encodedKeys[index] ?? EMPTY_BYTES;
    for (const byte of key) {
      output.push(byte);
    }
    const entry = entries[index];
    if (entry !== undefined) {
      encodeCborValue(entry[1], depth + 1, output);
    }
  }
}

const EMPTY_BYTES = new Uint8Array(0);

/**
 * 重複キー検査用にキーを正規化する (RFC 8949 Section 5.6.1)
 *
 * `-0.0` と `0.0` は数値として等しいため同一のキーになる。NaN は実装判断として
 * すべて同一視する (safe side。仕様は significand が同じ NaN だけを等価とする)。
 * 深さ制限を超える場合は undefined を返す。
 */
function normalizeCborKey(value: CborValue, depth: number): CborValue {
  checkDepth(depth);
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
 * 浮動小数点数を値を保つ最短の幅でエンコードする
 *
 * RFC 8949 Section 4.2.1 の preferred serialization と Section 4.2.2 の NaN の
 * 正規表現 (`f9 7e 00`) に従う。
 */
function encodeFloat(number: number, output: number[]): void {
  if (Number.isNaN(number)) {
    output.push(0xf9, 0x7e, 0x00);
    return;
  }
  const halfBits = f64ToF16Bits(number);
  if (f16ToF64(halfBits) === number) {
    output.push(0xf9);
    output.push(halfBits >> 8, halfBits & 0xff);
    return;
  }
  const single = Math.fround(number);
  if (single === number) {
    FLOAT_VIEW.setFloat32(0, single);
    const bits = FLOAT_VIEW.getUint32(0);
    output.push(0xfa);
    output.push((bits >>> 24) & 0xff, (bits >>> 16) & 0xff, (bits >>> 8) & 0xff, bits & 0xff);
    return;
  }
  FLOAT_VIEW.setFloat64(0, number);
  const bits = FLOAT_VIEW.getBigUint64(0);
  output.push(0xfb);
  for (let shift = 56n; shift >= 0n; shift -= 8n) {
    output.push(Number((bits >> shift) & 0xffn));
  }
}

/**
 * IEEE 754 倍精度のビット列を取得するための共有バッファ
 *
 * DataView はステートレスではないため、モジュール内で 1 つだけ作る。
 */
const FLOAT_BUFFER = new ArrayBuffer(8);
const FLOAT_VIEW = new DataView(FLOAT_BUFFER);
const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder("utf-8", { fatal: true });

/**
 * 2^-24 〜 2^15 の厳密な値 (添字 0 が 2^-24)
 *
 * 半精度 (binary16) の指数部を厳密に展開できる表を持つ。JavaScript の number は
 * 倍精度であり、2 の整数乗は乗除算の繰り返しで厳密に作れる。
 */
const F16_POWERS: number[] = (() => {
  const values: number[] = [];
  for (let index = 0; index < 40; index++) {
    const exponent = index - 24;
    let product = 1;
    for (let count = 0; count < Math.abs(exponent); count++) {
      product *= exponent >= 0 ? 2 : 0.5;
    }
    values.push(product);
  }
  return values;
})();

/**
 * IEEE 754 半精度 (binary16) のビット列を number へ変換する
 */
function f16ToF64(bits: number): number {
  const sign = (bits >> 15) & 1;
  const exponent = (bits >> 10) & 0x1f;
  const fraction = bits & 0x3ff;
  let magnitude: number;
  if (exponent === 0) {
    // 非正規数 (および ±0)
    magnitude = fraction * (F16_POWERS[0] ?? 0);
  } else if (exponent === 31) {
    magnitude = fraction === 0 ? Infinity : Number.NaN;
  } else {
    // 正規数: (1 + fraction / 1024) * 2^(exponent - 15)
    magnitude = ((1024 + fraction) * (F16_POWERS[exponent + 9] ?? 0)) / 1024;
  }
  return sign === 1 ? -magnitude : magnitude;
}

/**
 * number を IEEE 754 半精度 (binary16) のビット列に変換する
 *
 * 仮数部は切り捨てる近似で行う。呼び出し側は `f16ToF64` との往復で値が厳密に
 * 保たれることを確認してから使う (決定論的エンコードは値を変える幅を使ってはならない)。
 */
function f64ToF16Bits(number: number): number {
  FLOAT_VIEW.setFloat64(0, number);
  const bits = FLOAT_VIEW.getBigUint64(0);
  const sign = Number((bits >> 63n) & 1n) << 15;
  const exponent = Number((bits >> 52n) & 0x7ffn);
  const fraction = bits & 0x000f_ffff_ffff_ffffn;
  if (exponent === 0x7ff) {
    // 無限大と NaN。NaN は呼び出し側で正規化するためペイロードは問わない
    return fraction === 0n ? sign | 0x7c00 : 0x7e00;
  }
  const unbiased = exponent - 1023;
  if (unbiased > 15) {
    // 半精度で表現できない大きさ。呼び出し側の往復確認で不一致になる
    return sign | 0x7c00;
  }
  if (unbiased >= -14) {
    const mantissa = Number((fraction >> 42n) & 0x3ffn);
    return sign | ((unbiased + 15) << 10) | mantissa;
  }
  if (unbiased < -24) {
    // 半精度の最小非正規数より小さい。呼び出し側の往復確認で不一致になる
    return sign;
  }
  // 非正規数: 仮数部を 2^-24 単位に落とす
  const shift = BigInt(28 - unbiased);
  const mantissa = Number(((fraction | (1n << 52n)) >> shift) & 0xffffn);
  return sign | mantissa;
}

/**
 * CBOR のデコーダ
 *
 * 入力の位置を保持しながら 1 つのデータ項目を読み進める。
 */
class CborDecoder {
  readonly bytes: Uint8Array;
  position = 0;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  /**
   * additional information を読み、長さ / 値の引数を返す
   *
   * indefinite 長 (additional information 31) の場合は undefined を返す。
   */
  readArgument(additional: number): bigint | undefined {
    if (additional <= 23) {
      return BigInt(additional);
    }
    if (additional === 24) {
      return BigInt(this.readByte());
    }
    if (additional === 25) {
      const bytes = this.readExact(2);
      return BigInt(((bytes[0] ?? 0) << 8) | (bytes[1] ?? 0));
    }
    if (additional === 26) {
      // RFC 8949 Section 3: argument は network byte order の符号なし整数である。
      // JavaScript のビット演算は符号付き 32 ビットのため 2^31 以上で負になる。
      // additional information 27 と同じく 1 バイトずつ bigint へ積む
      const bytes = this.readExact(4);
      let value = 0n;
      for (const byte of bytes) {
        value = (value << 8n) | BigInt(byte);
      }
      return value;
    }
    if (additional === 27) {
      const bytes = this.readExact(8);
      let value = 0n;
      for (const byte of bytes) {
        value = (value << 8n) | BigInt(byte);
      }
      return value;
    }
    if (additional === 31) {
      return undefined;
    }
    throw new CborError("invalidAdditionalInformation", additional);
  }

  /**
   * 引数を必須とするデータ項目 (整数 / タグ) の値を返す
   */
  readArgumentValue(additional: number): bigint {
    const value = this.readArgument(additional);
    if (value === undefined) {
      throw new CborError("invalidAdditionalInformation", additional);
    }
    return value;
  }

  /**
   * 1 バイト読み込む
   */
  readByte(): number {
    const value = this.bytes[this.position];
    if (value === undefined) {
      throw new CborError("unexpectedEof");
    }
    this.position += 1;
    return value;
  }

  /**
   * 指定した長さのバイト列を読み込む
   *
   * 入力バッファを後から変更してもデコード結果が変わらないように、コピーを返す。
   */
  readExact(length: number): Uint8Array {
    const end = this.position + length;
    if (end > this.bytes.length) {
      throw new CborError("unexpectedEof");
    }
    const value = this.bytes.slice(this.position, end);
    this.position = end;
    return value;
  }

  /**
   * 次のバイトを消費せずに返す
   */
  peek(): number | undefined {
    return this.bytes[this.position];
  }

  /**
   * 長さの引数を安全な整数へ変換する
   */
  toLength(value: bigint): number {
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new CborError("lengthOverflow");
    }
    return Number(value);
  }

  /**
   * データ項目を 1 つデコードする
   */
  decodeValue(depth: number): CborValue {
    checkDepth(depth);
    const initial = this.readByte();
    const major = initial >> 5;
    const additional = initial & 0x1f;
    switch (major) {
      case 0:
        return cborUnsigned(this.readArgumentValue(additional));
      case 1:
        return cborNegative(this.readArgumentValue(additional));
      case 2:
        return cborByteString(this.readByteString(additional, 2));
      case 3: {
        const bytes = this.readByteString(additional, 3);
        return cborTextString(decodeUtf8(bytes));
      }
      case 4:
        return cborArray(this.readArray(additional, depth));
      case 5:
        return cborMap(this.readMap(additional, depth));
      case 6: {
        const tag = this.readArgumentValue(additional);
        return cborTag(tag, this.decodeValue(depth + 1));
      }
      default:
        return this.decodeSimpleValue(additional);
    }
  }

  /**
   * major type 7 (単純値 / 浮動小数点数) をデコードする
   */
  private decodeSimpleValue(additional: number): CborValue {
    if (additional <= 19) {
      return cborSimple(additional);
    }
    switch (additional) {
      case 20:
        return CBOR_FALSE;
      case 21:
        return CBOR_TRUE;
      case 22:
        return CBOR_NULL;
      case 23:
        return CBOR_UNDEFINED;
      case 24: {
        // RFC 8949 Section 3.3: 24 〜 31 は予約されており、単純値として使えない
        const value = this.readByte();
        if (value < 32) {
          throw new CborError("invalidSimpleValue", value);
        }
        return cborSimple(value);
      }
      case 25: {
        const bytes = this.readExact(2);
        const bits = ((bytes[0] ?? 0) << 8) | (bytes[1] ?? 0);
        return cborFloat(f16ToF64(bits));
      }
      case 26: {
        const bytes = this.readExact(4);
        FLOAT_VIEW.setUint32(
          0,
          ((bytes[0] ?? 0) << 24) |
            ((bytes[1] ?? 0) << 16) |
            ((bytes[2] ?? 0) << 8) |
            (bytes[3] ?? 0),
        );
        return cborFloat(FLOAT_VIEW.getFloat32(0));
      }
      case 27: {
        const bytes = this.readExact(8);
        FLOAT_VIEW.setUint32(
          0,
          ((bytes[0] ?? 0) << 24) |
            ((bytes[1] ?? 0) << 16) |
            ((bytes[2] ?? 0) << 8) |
            (bytes[3] ?? 0),
        );
        FLOAT_VIEW.setUint32(
          4,
          ((bytes[4] ?? 0) << 24) |
            ((bytes[5] ?? 0) << 16) |
            ((bytes[6] ?? 0) << 8) |
            (bytes[7] ?? 0),
        );
        return cborFloat(FLOAT_VIEW.getFloat64(0));
      }
      case 31:
        throw new CborError("breakOutsideIndefinite");
      default:
        throw new CborError("invalidAdditionalInformation", additional);
    }
  }

  /**
   * バイト文字列 / テキスト文字列を読む
   *
   * `expectedMajor` は本体の major type。indefinite 長のチャンクは同じ major type
   * でなければならない (RFC 8949 Section 3.2.3)。
   */
  private readByteString(additional: number, expectedMajor: number): Uint8Array {
    const length = this.readArgument(additional);
    if (length !== undefined) {
      return this.readExact(this.toLength(length));
    }
    const output: number[] = [];
    for (;;) {
      if (this.peek() === 0xff) {
        this.position += 1;
        return new Uint8Array(output);
      }
      const initial = this.readByte();
      const major = initial >> 5;
      const chunkAdditional = initial & 0x1f;
      if (major !== expectedMajor) {
        throw new CborError("invalidIndefiniteChunk");
      }
      const chunkLength = this.toLength(this.readArgumentValue(chunkAdditional));
      const chunk = this.readExact(chunkLength);
      if (expectedMajor === 3) {
        // RFC 8949 Section 3.2.3: indefinite 長のテキスト文字列は、各チャンクが
        // 個別に正しい UTF-8 でなければならない
        decodeUtf8(chunk);
      }
      for (const byte of chunk) {
        output.push(byte);
      }
    }
  }

  /**
   * 配列を読む (definite / indefinite の両方)
   */
  private readArray(additional: number, depth: number): CborValue[] {
    const output: CborValue[] = [];
    const length = this.readArgument(additional);
    if (length !== undefined) {
      const count = this.toLength(length);
      // 入力サイズから大きく乖離した確保を避けるため、count による事前確保はしない
      for (let index = 0; index < count; index++) {
        output.push(this.decodeValue(depth + 1));
      }
      return output;
    }
    for (;;) {
      if (this.peek() === 0xff) {
        this.position += 1;
        return output;
      }
      output.push(this.decodeValue(depth + 1));
    }
  }

  /**
   * マップを読む (definite / indefinite の両方)
   */
  private readMap(additional: number, depth: number): Array<[CborValue, CborValue]> {
    const output: Array<[CborValue, CborValue]> = [];
    const length = this.readArgument(additional);
    if (length !== undefined) {
      const count = this.toLength(length);
      for (let index = 0; index < count; index++) {
        output.push([this.decodeValue(depth + 1), this.decodeValue(depth + 1)]);
      }
    } else {
      for (;;) {
        if (this.peek() === 0xff) {
          this.position += 1;
          break;
        }
        output.push([this.decodeValue(depth + 1), this.decodeValue(depth + 1)]);
      }
    }
    if (hasDuplicateMapKeys(output)) {
      throw new CborError("duplicateMapKey");
    }
    return output;
  }
}

/**
 * マップのキーが重複しているかどうかを判定する
 *
 * キーを決定論的エンコードのバイト列へ変換してソートし、隣接比較する (O(n log n))。
 * 攻撃者入力の巨大なマップでも二次関数的な時間を使わない。RFC 8949 Section 5.6.1 は
 * 同じ内容を持つ NaN のキーを同一視するため、データ項目の等価比較ではなくバイト列で
 * 判定する。
 */
function hasDuplicateMapKeys(entries: Array<[CborValue, CborValue]>): boolean {
  const encodedKeys: Uint8Array[] = [];
  for (const entry of entries) {
    let normalized: CborValue;
    try {
      // 深さ制限を超えるキーは encode 側が別途拒否する
      normalized = normalizeCborKey(entry[0], 0);
    } catch (error) {
      if (error instanceof CborError) {
        return false;
      }
      throw error;
    }
    const keyOutput: number[] = [];
    try {
      encodeCborValue(normalized, 0, keyOutput);
    } catch (error) {
      if (error instanceof CborError) {
        // デコード済みのキーは必ずエンコードできる
        return false;
      }
      throw error;
    }
    encodedKeys.push(new Uint8Array(keyOutput));
  }
  encodedKeys.sort(compareBytes);
  for (let index = 1; index < encodedKeys.length; index++) {
    const previous = encodedKeys[index - 1] ?? EMPTY_BYTES;
    const current = encodedKeys[index] ?? EMPTY_BYTES;
    if (compareBytes(previous, current) === 0) {
      return true;
    }
  }
  return false;
}

/**
 * バイト列を UTF-8 のテキスト文字列へ変換する
 *
 * 不正な UTF-8 は `invalidUtf8` で拒否する。TextDecoder の fatal モードは置換文字
 * (U+FFFD) を返さずに例外を投げる。
 */
function decodeUtf8(bytes: Uint8Array): string {
  try {
    return TEXT_DECODER.decode(bytes);
  } catch {
    throw new CborError("invalidUtf8");
  }
}
