import { IncompleteDataError } from "./error";

/**
 * MOQT 可変長整数エンコーディング
 * draft-ietf-moq-transport-19 Section 1.4.1
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
 * draft-ietf-moq-transport-19 Section 1.4.1:
 * 9 バイト varint の Range は 0-18446744073709551615 (= 2^64-1)。
 */
export const MAX_VARINT = 18446744073709551615n;

/**
 * varint のエンコードに必要なバイト数を返す
 *
 * 2^64-1 を超える値は仕様の範囲外 (draft-ietf-moq-transport-19 Section 1.4.1) のため、
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
 * draft-ietf-moq-transport-19 Section 1.4.1:
 * Leading 1-bits の数で長さを示し、最初の 0 ビット後の残りビットと
 * 後続バイトに値をネットワークバイトオーダーでエンコードする。
 *
 * 2^64-1 を超える値は仕様の範囲外のため、例外を投げる (varintSize で検証)。
 */
export function encodeVarint(value: number | bigint): Uint8Array {
  const v = BigInt(value);
  if (v < 0n) {
    throw new Error(`negative value not allowed: ${value}`);
  }

  const size = varintSize(v);
  const result = new Uint8Array(size);

  switch (size) {
    case 1:
      // 0xxxxxxx (7 usable bits)
      result[0] = Number(v);
      break;
    case 2:
      // 10xxxxxx xxxxxxxx (14 usable bits)
      result[0] = 0x80 | Number((v >> 8n) & 0x3fn);
      result[1] = Number(v & 0xffn);
      break;
    case 3:
      // 110xxxxx xxxxxxxx xxxxxxxx (21 usable bits)
      result[0] = 0xc0 | Number((v >> 16n) & 0x1fn);
      result[1] = Number((v >> 8n) & 0xffn);
      result[2] = Number(v & 0xffn);
      break;
    case 4:
      // 1110xxxx xxxxxxxx xxxxxxxx xxxxxxxx (28 usable bits)
      result[0] = 0xe0 | Number((v >> 24n) & 0x0fn);
      result[1] = Number((v >> 16n) & 0xffn);
      result[2] = Number((v >> 8n) & 0xffn);
      result[3] = Number(v & 0xffn);
      break;
    case 5:
      // 11110xxx xxxxxxxx xxxxxxxx xxxxxxxx xxxxxxxx (35 usable bits)
      result[0] = 0xf0 | Number((v >> 32n) & 0x07n);
      result[1] = Number((v >> 24n) & 0xffn);
      result[2] = Number((v >> 16n) & 0xffn);
      result[3] = Number((v >> 8n) & 0xffn);
      result[4] = Number(v & 0xffn);
      break;
    case 6:
      // 111110xx xxxxxxxx xxxxxxxx xxxxxxxx xxxxxxxx xxxxxxxx (42 usable bits)
      result[0] = 0xf8 | Number((v >> 40n) & 0x03n);
      result[1] = Number((v >> 32n) & 0xffn);
      result[2] = Number((v >> 24n) & 0xffn);
      result[3] = Number((v >> 16n) & 0xffn);
      result[4] = Number((v >> 8n) & 0xffn);
      result[5] = Number(v & 0xffn);
      break;
    case 7:
      // 1111110x xxxxxxxx xxxxxxxx xxxxxxxx xxxxxxxx xxxxxxxx xxxxxxxx (49 usable bits)
      result[0] = 0xfc | Number((v >> 48n) & 0x01n);
      result[1] = Number((v >> 40n) & 0xffn);
      result[2] = Number((v >> 32n) & 0xffn);
      result[3] = Number((v >> 24n) & 0xffn);
      result[4] = Number((v >> 16n) & 0xffn);
      result[5] = Number((v >> 8n) & 0xffn);
      result[6] = Number(v & 0xffn);
      break;
    case 8:
      // 11111110 xxxxxxxx * 7 (56 usable bits)
      result[0] = 0xfe;
      result[1] = Number((v >> 48n) & 0xffn);
      result[2] = Number((v >> 40n) & 0xffn);
      result[3] = Number((v >> 32n) & 0xffn);
      result[4] = Number((v >> 24n) & 0xffn);
      result[5] = Number((v >> 16n) & 0xffn);
      result[6] = Number((v >> 8n) & 0xffn);
      result[7] = Number(v & 0xffn);
      break;
    case 9:
      // 11111111 xxxxxxxx * 8 (64 usable bits)
      result[0] = 0xff;
      result[1] = Number((v >> 56n) & 0xffn);
      result[2] = Number((v >> 48n) & 0xffn);
      result[3] = Number((v >> 40n) & 0xffn);
      result[4] = Number((v >> 32n) & 0xffn);
      result[5] = Number((v >> 24n) & 0xffn);
      result[6] = Number((v >> 16n) & 0xffn);
      result[7] = Number((v >> 8n) & 0xffn);
      result[8] = Number(v & 0xffn);
      break;
  }

  return result;
}

/**
 * MOQT varint 形式からデコードする
 *
 * draft-ietf-moq-transport-19 Section 1.4.1:
 * Leading 1-bits の数から長さを決定し、値をデコードする。
 *
 * @returns [デコードされた値, 消費したバイト数]
 */
export function decodeVarint(data: Uint8Array, offset = 0): [bigint, number] {
  const available = data.length - offset;
  if (available < 1) {
    throw new IncompleteDataError(`insufficient data: need 1 byte, got ${available}`);
  }

  const firstByte = data[offset];

  // Leading 1-bits の数を数えてエンコード長を決定
  let length: number;
  let usableBitsInFirstByte: number;

  if ((firstByte & 0x80) === 0) {
    // 0xxxxxxx: 1 byte
    length = 1;
    usableBitsInFirstByte = 7;
  } else if ((firstByte & 0xc0) === 0x80) {
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

  // 値のデコード
  const mask = (1 << usableBitsInFirstByte) - 1;
  let value = BigInt(firstByte & mask);

  for (let i = 1; i < length; i++) {
    value = (value << 8n) | BigInt(data[offset + i]);
  }

  return [value, length];
}
