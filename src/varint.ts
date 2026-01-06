/**
 * QUIC Variable-Length Integer エンコーディング
 * RFC 9000 Section 16 に基づく実装
 */

// 最大値: 2^62 - 1
const MAX_VARINT = 4611686018427387903n;

// エンコードの閾値
const THRESHOLD_1BYTE = 63n;
const THRESHOLD_2BYTE = 16383n;
const THRESHOLD_4BYTE = 1073741823n;

/**
 * varint のエンコードに必要なバイト数を返す
 */
export function varintSize(value: number | bigint): number {
  const v = BigInt(value);
  if (v < 0n) {
    throw new Error(`negative value not allowed: ${value}`);
  }
  if (v > MAX_VARINT) {
    throw new Error(`value exceeds maximum (2^62-1): ${value}`);
  }
  if (v <= THRESHOLD_1BYTE) return 1;
  if (v <= THRESHOLD_2BYTE) return 2;
  if (v <= THRESHOLD_4BYTE) return 4;
  return 8;
}

/**
 * 整数を QUIC varint 形式にエンコードする
 */
export function encodeVarint(value: number | bigint): Uint8Array {
  const v = BigInt(value);
  if (v < 0n) {
    throw new Error(`negative value not allowed: ${value}`);
  }
  if (v > MAX_VARINT) {
    throw new Error(`value exceeds maximum (2^62-1): ${value}`);
  }

  const size = varintSize(v);
  const result = new Uint8Array(size);

  switch (size) {
    case 1:
      // 6 bits, prefix 00
      result[0] = Number(v);
      break;
    case 2: {
      // 14 bits, prefix 01
      const val = Number(v) | 0x4000;
      result[0] = (val >> 8) & 0xff;
      result[1] = val & 0xff;
      break;
    }
    case 4: {
      // 30 bits, prefix 10
      const val = Number(v) | 0x80000000;
      result[0] = (val >> 24) & 0xff;
      result[1] = (val >> 16) & 0xff;
      result[2] = (val >> 8) & 0xff;
      result[3] = val & 0xff;
      break;
    }
    case 8: {
      // 62 bits, prefix 11
      const val = v | 0xc000000000000000n;
      result[0] = Number((val >> 56n) & 0xffn);
      result[1] = Number((val >> 48n) & 0xffn);
      result[2] = Number((val >> 40n) & 0xffn);
      result[3] = Number((val >> 32n) & 0xffn);
      result[4] = Number((val >> 24n) & 0xffn);
      result[5] = Number((val >> 16n) & 0xffn);
      result[6] = Number((val >> 8n) & 0xffn);
      result[7] = Number(val & 0xffn);
      break;
    }
  }

  return result;
}

/**
 * QUIC varint 形式からデコードする
 * @returns [デコードされた値, 消費したバイト数]
 */
export function decodeVarint(data: Uint8Array, offset = 0): [bigint, number] {
  const available = data.length - offset;
  if (available < 1) {
    throw new Error(`insufficient data: need 1 byte, got ${available}`);
  }

  const firstByte = data[offset];
  const prefix = firstByte >> 6;

  switch (prefix) {
    case 0: {
      // 1 byte
      return [BigInt(firstByte & 0x3f), 1];
    }
    case 1: {
      // 2 bytes
      if (available < 2) {
        throw new Error(`insufficient data: need 2 bytes, got ${available}`);
      }
      const value = ((firstByte & 0x3f) << 8) | data[offset + 1];
      return [BigInt(value), 2];
    }
    case 2: {
      // 4 bytes
      if (available < 4) {
        throw new Error(`insufficient data: need 4 bytes, got ${available}`);
      }
      const value =
        ((firstByte & 0x3f) << 24) |
        (data[offset + 1] << 16) |
        (data[offset + 2] << 8) |
        data[offset + 3];
      return [BigInt(value >>> 0), 4];
    }
    case 3: {
      // 8 bytes
      if (available < 8) {
        throw new Error(`insufficient data: need 8 bytes, got ${available}`);
      }
      let value = BigInt(firstByte & 0x3f);
      for (let i = 1; i < 8; i++) {
        value = (value << 8n) | BigInt(data[offset + i]);
      }
      return [value, 8];
    }
    default:
      throw new Error(`invalid varint prefix: 0x${prefix.toString(16)}`);
  }
}
