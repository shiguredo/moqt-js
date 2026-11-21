import { IncompleteDataError } from "./error";

/**
 * MOQT 可変長整数エンコーディング
 * draft-ietf-moq-transport-23 Section 8.1
 *
 * Leading 1-bits の数でエンコード長を決定する。
 * 最初の 0 ビットの後の残りビットと後続バイトが値を表す。
 *
 * | Leading Bits | Length | Usable Bits | Range                      |
 * |--------------|--------|-------------|----------------------------|
 * | 0            | 1      | 7           | 0-127                      |
 * | 10           | 2      | 14          | 0-16383                    |
 * | 110          | 3      | 21          | 0-2097151                  |
 * | 1110         | 4      | 28          | 0-268435455                |
 * | 11110        | 5      | 35          | 0-34359738367              |
 * | 111110       | 6      | 42          | 0-4398046511103            |
 * | 1111110      | 7      | 49          | 0-562949953421311          |
 * | 11111110     | 8      | 56          | 0-72057594037927935        |
 * | 11111111     | 9      | 64          | 0-18446744073709551615     |
 */

// 各長さの最大値
const THRESHOLD_1BYTE = 127n;
const THRESHOLD_2BYTE = 16383n;
const THRESHOLD_3BYTE = 2097151n;
const THRESHOLD_4BYTE = 268435455n;
const THRESHOLD_5BYTE = 34359738367n;
const THRESHOLD_6BYTE = 4398046511103n;
const THRESHOLD_7BYTE = 562949953421311n;
const THRESHOLD_8BYTE = 72057594037927935n;
// 9 byte: 全 64 ビット

/**
 * varint で表現できる最大値 (2^64-1)
 *
 * draft-ietf-moq-transport-23 Section 8.1:
 * 9 バイト varint の Range は 0-18446744073709551615 (= 2^64-1)。
 */
export const MAX_VARINT = 18446744073709551615n;

/**
 * varint のエンコードに必要なバイト数を返す
 *
 * 2^64-1 を超える値は仕様の範囲外 (draft-ietf-moq-transport-23 Section 8.1) のため、
 * 負値と同様に例外を投げる。
 */
export function varintSize(value: number | bigint): number {
  const v = BigInt(value);
  if (v < 0n) {
    throw new Error(`negative value not allowed: ${value}`);
  }
  if (v > MAX_VARINT) {
    throw new Error(`value exceeds varint maximum: ${value} > ${MAX_VARINT}`);
  }
  if (v <= THRESHOLD_1BYTE) return 1;
  if (v <= THRESHOLD_2BYTE) return 2;
  if (v <= THRESHOLD_3BYTE) return 3;
  if (v <= THRESHOLD_4BYTE) return 4;
  if (v <= THRESHOLD_5BYTE) return 5;
  if (v <= THRESHOLD_6BYTE) return 6;
  if (v <= THRESHOLD_7BYTE) return 7;
  if (v <= THRESHOLD_8BYTE) return 8;
  return 9;
}

/**
 * 整数を MOQT varint 形式にエンコードする
 *
 * draft-ietf-moq-transport-23 Section 8.1:
 * Leading 1-bits の数で長さを示し、最初の 0 ビット後の残りビットと
 * 後続バイトに値をネットワークバイトオーダーでエンコードする。
 *
 * 2^64-1 を超える値は仕様の範囲外のため、例外を投げる (varintSize で検証)。
 */
export function encodeVarint(value: number | bigint): Uint8Array {
  const size = varintSize(value);
  const result = new Uint8Array(size);
  // 先頭の 1 を size - 1 個並べる。9 バイトでは先頭全体が 0xff になる。
  const prefix = 0x100 - (0x100 >>> (size - 1));

  // 4 バイト以下の値は 28 ビット以下。number のまま下位バイトから書く。
  if (size <= 4) {
    let remaining = Number(value);
    for (let index = size - 1; index > 0; index--) {
      result[index] = remaining;
      remaining >>>= 8;
    }
    result[0] = prefix | remaining;
    return result;
  }

  // 5 バイト以上は 32 ビットずつに分け、各バイトで BigInt をシフトしない。
  const wide = BigInt(value);
  const low = Number(wide & 0xffffffffn);
  let high = Number(wide >> 32n);
  result[size - 1] = low;
  result[size - 2] = low >>> 8;
  result[size - 3] = low >>> 16;
  result[size - 4] = low >>> 24;
  const firstPayloadIndex = size === 9 ? 1 : 0;
  for (let index = size - 5; index >= firstPayloadIndex; index--) {
    result[index] = high;
    high >>>= 8;
  }
  result[0] = prefix | (result[0] ?? 0);
  return result;
}

/**
 * MOQT varint 形式からデコードする
 *
 * draft-ietf-moq-transport-23 Section 8.1:
 * Leading 1-bits の数から長さを決定し、値をデコードする。
 *
 * @returns [デコードされた値, 消費したバイト数]
 */
export function decodeVarint(data: Uint8Array, offset = 0): [bigint, number] {
  const available = data.length - offset;
  const firstByte = data[offset];
  if (firstByte === undefined) {
    throw new IncompleteDataError(`insufficient data: need 1 byte, got ${available}`);
  }

  if (firstByte < 0x80) {
    return [BigInt(firstByte), 1];
  }

  // Leading 1-bits の数を数えてエンコード長を決定
  let length: number;
  let usableBitsInFirstByte: number;

  if ((firstByte & 0xc0) === 0x80) {
    // 10xxxxxx: 2 bytes
    length = 2;
    usableBitsInFirstByte = 6;
  } else if ((firstByte & 0xe0) === 0xc0) {
    // 110xxxxx: 3 bytes
    length = 3;
    usableBitsInFirstByte = 5;
  } else if ((firstByte & 0xf0) === 0xe0) {
    // 1110xxxx: 4 bytes
    length = 4;
    usableBitsInFirstByte = 4;
  } else if ((firstByte & 0xf8) === 0xf0) {
    // 11110xxx: 5 bytes
    length = 5;
    usableBitsInFirstByte = 3;
  } else if ((firstByte & 0xfc) === 0xf8) {
    // 111110xx: 6 bytes
    length = 6;
    usableBitsInFirstByte = 2;
  } else if ((firstByte & 0xfe) === 0xfc) {
    // 1111110x: 7 bytes
    length = 7;
    usableBitsInFirstByte = 1;
  } else if (firstByte === 0xfe) {
    // 11111110: 8 bytes
    length = 8;
    usableBitsInFirstByte = 0;
  } else {
    // 11111111: 9 bytes
    length = 9;
    usableBitsInFirstByte = 0;
  }

  if (available < length) {
    throw new IncompleteDataError(`insufficient data: need ${length} bytes, got ${available}`);
  }

  // §8.1: 7 バイトまでの値は最大 49 ビットなので number で正確に積み上げられる。
  // 8、9 バイトでは最後の 4 バイトを分け、2 つの 32 ビット以下の値として読む。
  const mask = (1 << usableBitsInFirstByte) - 1;
  const end = offset + length;
  const highEnd = length <= 7 ? end : end - 4;
  let high = firstByte & mask;
  let cursor = offset + 1;
  for (; cursor < highEnd; cursor++) {
    // available の検査済みなので cursor のバイトは常に存在する。
    high = high * 256 + (data[cursor] ?? 0);
  }
  if (highEnd === end) {
    return [BigInt(high), length];
  }

  let low = 0;
  for (; cursor < end; cursor++) {
    low = low * 256 + (data[cursor] ?? 0);
  }
  return [(BigInt(high) << 32n) | BigInt(low), length];
}
