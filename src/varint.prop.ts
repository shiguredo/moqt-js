/**
 * Varint Property-Based Tests
 * RFC 9000 Section 16 に基づく QUIC Variable-Length Integer のプロパティテスト
 */

import { test, assert } from "vitest";
import * as fc from "fast-check";
import { encodeVarint, decodeVarint, varintSize } from "./varint";

// 各サイズ範囲の閾値
const THRESHOLD_1BYTE = 63n;
const THRESHOLD_2BYTE = 16383n;
const THRESHOLD_4BYTE = 1073741823n;
const MAX_VARINT = 4611686018427387903n;

// 1 バイト範囲の任意の値を生成する Arbitrary
const varint1ByteArb = fc.bigInt({ min: 0n, max: THRESHOLD_1BYTE });

// 2 バイト範囲の任意の値を生成する Arbitrary
const varint2ByteArb = fc.bigInt({ min: THRESHOLD_1BYTE + 1n, max: THRESHOLD_2BYTE });

// 4 バイト範囲の任意の値を生成する Arbitrary
const varint4ByteArb = fc.bigInt({ min: THRESHOLD_2BYTE + 1n, max: THRESHOLD_4BYTE });

// 8 バイト範囲の任意の値を生成する Arbitrary
const varint8ByteArb = fc.bigInt({ min: THRESHOLD_4BYTE + 1n, max: MAX_VARINT });

// 全範囲の有効な varint 値を生成する Arbitrary
const varintArb = fc.oneof(varint1ByteArb, varint2ByteArb, varint4ByteArb, varint8ByteArb);

test("エンコードとデコードのラウンドトリップが成立する", () => {
  fc.assert(
    fc.property(varintArb, (value) => {
      const encoded = encodeVarint(value);
      const [decoded, consumed] = decodeVarint(encoded);
      assert.equal(decoded, value);
      assert.equal(consumed, encoded.length);
    }),
  );
});

test("varintSize はエンコード結果のバイト数と一致する", () => {
  fc.assert(
    fc.property(varintArb, (value) => {
      const expectedSize = varintSize(value);
      const encoded = encodeVarint(value);
      assert.equal(encoded.length, expectedSize);
    }),
  );
});

test("1 バイト範囲の値は 1 バイトにエンコードされる", () => {
  fc.assert(
    fc.property(varint1ByteArb, (value) => {
      assert.equal(varintSize(value), 1);
      const encoded = encodeVarint(value);
      assert.equal(encoded.length, 1);
      // プレフィックスは 00
      assert.equal(encoded[0] >> 6, 0);
    }),
  );
});

test("2 バイト範囲の値は 2 バイトにエンコードされる", () => {
  fc.assert(
    fc.property(varint2ByteArb, (value) => {
      assert.equal(varintSize(value), 2);
      const encoded = encodeVarint(value);
      assert.equal(encoded.length, 2);
      // プレフィックスは 01
      assert.equal(encoded[0] >> 6, 1);
    }),
  );
});

test("4 バイト範囲の値は 4 バイトにエンコードされる", () => {
  fc.assert(
    fc.property(varint4ByteArb, (value) => {
      assert.equal(varintSize(value), 4);
      const encoded = encodeVarint(value);
      assert.equal(encoded.length, 4);
      // プレフィックスは 10
      assert.equal(encoded[0] >> 6, 2);
    }),
  );
});

test("8 バイト範囲の値は 8 バイトにエンコードされる", () => {
  fc.assert(
    fc.property(varint8ByteArb, (value) => {
      assert.equal(varintSize(value), 8);
      const encoded = encodeVarint(value);
      assert.equal(encoded.length, 8);
      // プレフィックスは 11
      assert.equal(encoded[0] >> 6, 3);
    }),
  );
});

test("number 型と bigint 型で同じエンコード結果になる", () => {
  // Number.MAX_SAFE_INTEGER 以下の値でテスト
  const safeIntArb = fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER });
  fc.assert(
    fc.property(safeIntArb, (value) => {
      const encodedFromNumber = encodeVarint(value);
      const encodedFromBigInt = encodeVarint(BigInt(value));
      assert.deepEqual(encodedFromNumber, encodedFromBigInt);
    }),
  );
});

test("オフセットを指定したデコードが正しく動作する", () => {
  fc.assert(
    fc.property(
      fc.array(fc.integer({ min: 0, max: 255 }), { minLength: 0, maxLength: 10 }),
      varintArb,
      fc.array(fc.integer({ min: 0, max: 255 }), { minLength: 0, maxLength: 10 }),
      (prefix, value, suffix) => {
        const encoded = encodeVarint(value);
        const prefixBytes = new Uint8Array(prefix);
        const suffixBytes = new Uint8Array(suffix);

        const combined = new Uint8Array(prefixBytes.length + encoded.length + suffixBytes.length);
        combined.set(prefixBytes, 0);
        combined.set(encoded, prefixBytes.length);
        combined.set(suffixBytes, prefixBytes.length + encoded.length);

        const [decoded, consumed] = decodeVarint(combined, prefixBytes.length);
        assert.equal(decoded, value);
        assert.equal(consumed, encoded.length);
      },
    ),
  );
});

test("連続したエンコード値を順次デコードできる", () => {
  fc.assert(
    fc.property(fc.array(varintArb, { minLength: 1, maxLength: 20 }), (values) => {
      // 全ての値をエンコードして連結
      const encodedArrays = values.map((v) => encodeVarint(v));
      const totalLength = encodedArrays.reduce((sum, arr) => sum + arr.length, 0);
      const combined = new Uint8Array(totalLength);
      let pos = 0;
      for (const arr of encodedArrays) {
        combined.set(arr, pos);
        pos += arr.length;
      }

      // 順次デコード
      let offset = 0;
      for (const expected of values) {
        const [decoded, consumed] = decodeVarint(combined, offset);
        assert.equal(decoded, expected);
        offset += consumed;
      }
      assert.equal(offset, totalLength);
    }),
  );
});

test("負の値はエラーになる", () => {
  fc.assert(
    fc.property(fc.bigInt({ min: -1000000n, max: -1n }), (value) => {
      assert.throws(() => encodeVarint(value));
      assert.throws(() => varintSize(value));
    }),
  );
});

test("最大値を超える値はエラーになる", () => {
  fc.assert(
    fc.property(fc.bigInt({ min: MAX_VARINT + 1n, max: MAX_VARINT + 1000000n }), (value) => {
      assert.throws(() => encodeVarint(value));
      assert.throws(() => varintSize(value));
    }),
  );
});
