/**
 * Varint Property-Based Tests
 * draft-ietf-moq-transport-19 Section 1.4.1 に基づく MOQT 可変長整数のプロパティテスト
 */

import { test, assert } from "vite-plus/test";
import * as fc from "fast-check";
import { encodeVarint, decodeVarint, varintSize, MAX_VARINT } from "./varint";

// 各サイズ範囲の閾値
const THRESHOLD_1BYTE = 127n;
const THRESHOLD_2BYTE = 16383n;
const THRESHOLD_3BYTE = 2097151n;
const THRESHOLD_4BYTE = 268435455n;
const THRESHOLD_5BYTE = 34359738367n;
const THRESHOLD_6BYTE = 4398046511103n;
const THRESHOLD_7BYTE = 562949953421311n;
const THRESHOLD_8BYTE = 72057594037927935n;

// 各サイズ範囲の Arbitrary
const varint1ByteArb = fc.bigInt({ min: 0n, max: THRESHOLD_1BYTE });
const varint2ByteArb = fc.bigInt({ min: THRESHOLD_1BYTE + 1n, max: THRESHOLD_2BYTE });
const varint3ByteArb = fc.bigInt({ min: THRESHOLD_2BYTE + 1n, max: THRESHOLD_3BYTE });
const varint4ByteArb = fc.bigInt({ min: THRESHOLD_3BYTE + 1n, max: THRESHOLD_4BYTE });
const varint5ByteArb = fc.bigInt({ min: THRESHOLD_4BYTE + 1n, max: THRESHOLD_5BYTE });
const varint6ByteArb = fc.bigInt({ min: THRESHOLD_5BYTE + 1n, max: THRESHOLD_6BYTE });
const varint7ByteArb = fc.bigInt({ min: THRESHOLD_6BYTE + 1n, max: THRESHOLD_7BYTE });
const varint8ByteArb = fc.bigInt({ min: THRESHOLD_7BYTE + 1n, max: THRESHOLD_8BYTE });
const varint9ByteArb = fc.bigInt({ min: THRESHOLD_8BYTE + 1n, max: MAX_VARINT });

// 全範囲の有効な varint 値を生成する Arbitrary
const varintArb = fc.oneof(
  varint1ByteArb,
  varint2ByteArb,
  varint3ByteArb,
  varint4ByteArb,
  varint5ByteArb,
  varint6ByteArb,
  varint7ByteArb,
  varint8ByteArb,
  varint9ByteArb,
);

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
      // 先頭ビットは 0
      assert.equal(encoded[0] & 0x80, 0);
    }),
  );
});

test("2 バイト範囲の値は 2 バイトにエンコードされる", () => {
  fc.assert(
    fc.property(varint2ByteArb, (value) => {
      assert.equal(varintSize(value), 2);
      const encoded = encodeVarint(value);
      assert.equal(encoded.length, 2);
      // プレフィックスは 10
      assert.equal(encoded[0] & 0xc0, 0x80);
    }),
  );
});

test("3 バイト範囲の値は 3 バイトにエンコードされる", () => {
  fc.assert(
    fc.property(varint3ByteArb, (value) => {
      assert.equal(varintSize(value), 3);
      const encoded = encodeVarint(value);
      assert.equal(encoded.length, 3);
      // プレフィックスは 110
      assert.equal(encoded[0] & 0xe0, 0xc0);
    }),
  );
});

test("4 バイト範囲の値は 4 バイトにエンコードされる", () => {
  fc.assert(
    fc.property(varint4ByteArb, (value) => {
      assert.equal(varintSize(value), 4);
      const encoded = encodeVarint(value);
      assert.equal(encoded.length, 4);
      // プレフィックスは 1110
      assert.equal(encoded[0] & 0xf0, 0xe0);
    }),
  );
});

test("7 バイト範囲の値は 7 バイトにエンコードされる", () => {
  fc.assert(
    fc.property(varint7ByteArb, (value) => {
      assert.equal(varintSize(value), 7);
      const encoded = encodeVarint(value);
      assert.equal(encoded.length, 7);
      // プレフィックスは 1111110
      assert.equal(encoded[0] & 0xfe, 0xfc);
    }),
  );
});

test("8 バイト範囲の値は 8 バイトにエンコードされる", () => {
  fc.assert(
    fc.property(varint8ByteArb, (value) => {
      assert.equal(varintSize(value), 8);
      const encoded = encodeVarint(value);
      assert.equal(encoded.length, 8);
      // プレフィックスは 11111110
      assert.equal(encoded[0], 0xfe);
    }),
  );
});

test("9 バイト範囲の値は 9 バイトにエンコードされる", () => {
  fc.assert(
    fc.property(varint9ByteArb, (value) => {
      assert.equal(varintSize(value), 9);
      const encoded = encodeVarint(value);
      assert.equal(encoded.length, 9);
      // プレフィックスは 11111111
      assert.equal(encoded[0], 0xff);
    }),
  );
});

test("number 型と bigint 型で同じエンコード結果になる", () => {
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
      const encodedArrays = values.map((v) => encodeVarint(v));
      const totalLength = encodedArrays.reduce((sum, arr) => sum + arr.length, 0);
      const combined = new Uint8Array(totalLength);
      let pos = 0;
      for (const arr of encodedArrays) {
        combined.set(arr, pos);
        pos += arr.length;
      }

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

// draft-ietf-moq-transport-19 Section 1.4.1:
// 9 バイト varint の Range は 0-2^64-1 であり、2^64 以上は仕様の範囲外。
// 範囲外入力は無音で mod 2^64 にラップされるデータ破壊を防ぐため、
// encodeVarint / varintSize の両方が例外を投げることを検証する。
test("2^64 以上の値は encodeVarint / varintSize で例外になる", () => {
  fc.assert(
    fc.property(fc.bigInt({ min: MAX_VARINT + 1n, max: 2n ** 80n }), (value) => {
      assert.throws(() => encodeVarint(value));
      assert.throws(() => varintSize(value));
    }),
  );
});
