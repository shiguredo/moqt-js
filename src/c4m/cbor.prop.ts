/**
 * CBOR (RFC 8949) のコーデックの Property-Based Testing
 *
 * 決定論的エンコードの性質 (往復・安定性・最短形式・キー順序) と、任意入力に対する
 * デコーダの全域性を、任意のデータ項目で確認する。
 */

import { test, assert } from "vite-plus/test";
import * as fc from "fast-check";
import {
  type CborValue,
  CborError,
  MAX_CBOR_DEPTH,
  cborArray,
  cborAsArray,
  cborAsBool,
  cborAsBytes,
  cborAsInt64,
  cborAsInteger,
  cborAsMap,
  cborAsNumber,
  cborAsText,
  cborAsUnsigned,
  cborByteString,
  cborEquals,
  cborFloat,
  cborMap,
  cborMapGet,
  cborTag,
  cborTextString,
  cborUnsigned,
  decodeCbor,
  decodeCborPartial,
  encodeCbor,
} from "./cbor";
import { assertCborError, cborValueArbitrary, encodeHex } from "./testSupport";

/** 生成するデータ項目のネスト深度の上限 */
const MAX_TEST_DEPTH = 4;

/** CborError が取り得るエラーコード */
const CBOR_ERROR_CODES: readonly string[] = [
  "unexpectedEof",
  "invalidAdditionalInformation",
  "invalidSimpleValue",
  "invalidUtf8",
  "breakOutsideIndefinite",
  "invalidIndefiniteChunk",
  "duplicateMapKey",
  "depthLimitExceeded",
  "lengthOverflow",
  "invalidInteger",
  "trailingBytes",
];

test("エンコードとデコードは往復する", () => {
  fc.assert(
    fc.property(cborValueArbitrary(MAX_TEST_DEPTH), (value) => {
      const encoded = encodeCbor(value);
      assert.deepEqual(decodeCbor(encoded), value);
    }),
  );
});

test("任意のバイト列はデコードできるか CborError になり、成功時は値として正規化される", () => {
  fc.assert(
    fc.property(fc.uint8Array({ maxLength: 64, size: "max" }), (bytes) => {
      let decoded: CborValue;
      try {
        decoded = decodeCbor(bytes);
      } catch (error) {
        // 他の例外 (RangeError など) が漏れないことまで確認する
        assert.ok(
          error instanceof CborError,
          `CborError を期待したが ${String(error)} が送出された`,
        );
        assert.include(CBOR_ERROR_CODES, error.code);
        return;
      }
      // 成功した場合は入力の全バイトを消費し、再エンコードが安定する
      assert.equal(decodeCborPartial(bytes).consumed, bytes.length);
      const encoded = encodeCbor(decoded);
      assert.deepEqual(decodeCbor(encoded), decoded);
      assert.deepEqual(encodeCbor(decodeCbor(encoded)), encoded);
    }),
  );
});

test("decodeCborPartial の consumed は先頭のデータ項目の長さである", () => {
  // データ項目の後ろに任意のバイト列があっても、先頭の項目だけを読む
  fc.assert(
    fc.property(
      cborValueArbitrary(MAX_TEST_DEPTH),
      fc.uint8Array({ maxLength: 32, size: "max" }),
      (value, tail) => {
        const encoded = encodeCbor(value);
        const bytes = new Uint8Array(encoded.length + tail.length);
        bytes.set(encoded);
        bytes.set(tail, encoded.length);
        const partial = decodeCborPartial(bytes);
        assert.deepEqual(partial.value, value);
        assert.equal(partial.consumed, encoded.length);
        assert.deepEqual(decodeCbor(bytes.subarray(0, partial.consumed)), value);
      },
    ),
  );

  // 先頭の項目より短い接頭辞は、必ず途中で尽きる
  fc.assert(
    fc.property(
      cborValueArbitrary(2),
      fc.uint8Array({ maxLength: 16, size: "max" }),
      (value, tail) => {
        const encoded = encodeCbor(value);
        const bytes = new Uint8Array(encoded.length + tail.length);
        bytes.set(encoded);
        bytes.set(tail, encoded.length);
        const { consumed } = decodeCborPartial(bytes);
        for (let length = 0; length < consumed; length++) {
          assertCborError(() => decodeCbor(bytes.subarray(0, length)), "unexpectedEof");
        }
      },
    ),
  );
});

test("マップのキー順序は入力順に依存せず、エンコード済みバイト列の昇順になる", () => {
  // 型を混ぜたキーを作る。同じキーが 2 つあると duplicateMapKey になるため重複を除く
  const keyArbitrary: fc.Arbitrary<CborValue> = fc.oneof(
    fc.bigInt({ min: 0n, max: 18446744073709551615n }).map((value) => cborUnsigned(value)),
    fc
      .bigInt({ min: 0n, max: 18446744073709551615n })
      .map((value) => cborTag(0n, cborUnsigned(value))),
    fc.stringMatching(/^[a-z]{0,3}$/).map((value) => cborTextString(value)),
    fc.uint8Array({ maxLength: 2, size: "max" }).map((value) => cborByteString(value)),
    fc.constantFrom(1.5, 0, -0, 100000).map((value) => cborFloat(value)),
  );
  const keyIdentity = (key: CborValue): string => {
    switch (key.type) {
      case "textString":
        return `t:${key.value}`;
      case "byteString":
        return `b:${encodeHex(key.value)}`;
      case "tag":
        return `g:${String(key.tag)}:${keyIdentity(key.value)}`;
      case "float":
        // -0.0 と 0.0 は同じキーとして扱われる
        return `f:${key.value === 0 ? "0" : String(key.value)}`;
      case "unsigned":
      case "negative":
        return `n:${key.type}:${String(key.value)}`;
      default:
        return `o:${key.type}`;
    }
  };
  const entriesArbitrary = fc
    .uniqueArray(keyArbitrary, { selector: keyIdentity, minLength: 2, maxLength: 4, size: "max" })
    .chain((keys) =>
      fc
        .shuffledSubarray(keys, { minLength: keys.length, maxLength: keys.length })
        .map((shuffled) => ({ keys, shuffled })),
    );

  fc.assert(
    fc.property(entriesArbitrary, ({ keys, shuffled }) => {
      const entries = keys.map((key): [CborValue, CborValue] => [key, cborUnsigned(1n)]);
      const shuffledEntries = shuffled.map((key): [CborValue, CborValue] => [
        key,
        cborUnsigned(1n),
      ]);
      const encoded = encodeCbor(cborMap(entries));
      assert.deepEqual(encodeCbor(cborMap(shuffledEntries)), encoded);

      // 出力順は「キーを単独でエンコードしたバイト列」の辞書順になる (RFC 8949 Section 4.2.1)
      const decoded = decodeCbor(encoded);
      const decodedKeys = cborAsMap(decoded)?.map((entry) => entry[0]) ?? [];
      assert.equal(decodedKeys.length, keys.length);
      const expectedOrder = keys
        .slice()
        .sort((left, right) => compareBytes(encodeCbor(left), encodeCbor(right)));
      assert.deepEqual(
        decodedKeys.map((key) => keyIdentity(key)),
        expectedOrder.map((key) => keyIdentity(key)),
      );
    }),
  );
});

/**
 * バイト列を辞書順で比較する (RFC 8949 Section 4.2.1)
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

test("浮動小数点数は値を保つ最短の幅でエンコードされる", () => {
  fc.assert(
    fc.property(fc.double(), (value) => {
      const encoded = encodeCbor(cborFloat(value));
      // 半精度 (3) / 単精度 (5) / 倍精度 (9) のいずれか
      assert.include([3, 5, 9], encoded.length);

      if (Number.isNaN(value)) {
        // NaN は常に半精度の quiet NaN にする (RFC 8949 Section 4.2.1)
        assert.equal(encodeHex(encoded), "f97e00");
        return;
      }
      if (encoded.length < 9) {
        // 単精度で表せない値を 5 バイト以下で書いてはいけない
        assert.ok(
          Object.is(Math.fround(value), value),
          `単精度で表せない値 ${String(value)} が ${String(encoded.length)} バイトで書かれた`,
        );
      }
      // 符号付きゼロを含めて値が保たれる
      const decoded = decodeCbor(encoded);
      assert.equal(decoded.type, "float");
      if (decoded.type === "float") {
        assert.ok(Object.is(decoded.value, value), `${String(decoded.value)} !== ${String(value)}`);
      }
    }),
  );
});

test("cborEquals は対称で、NaN を含まない値では反射的である", () => {
  fc.assert(
    fc.property(cborValueArbitrary(3), cborValueArbitrary(3), (left, right) => {
      assert.equal(cborEquals(left, right), cborEquals(right, left));
    }),
  );
  fc.assert(
    fc.property(cborValueArbitrary(3), (value) => {
      // NaN は CBOR のデータ項目として等しくない (f64 の == と同じ)
      assert.equal(cborEquals(value, value), !containsNaN(value));
    }),
  );
});

test("cborEquals は符号付きゼロの符号を区別しない", () => {
  fc.assert(
    fc.property(cborValueArbitrary(3), (value) => {
      const flipped = flipZeroSign(value);
      // 0.0 と -0.0 は等しく、NaN の有無は変わらないため、両方向で等価になる
      assert.equal(cborEquals(value, flipped), !containsNaN(value));
      assert.equal(cborEquals(flipped, value), !containsNaN(value));
    }),
  );
});

/**
 * NaN の浮動小数点数を含むかどうかを返す
 */
function containsNaN(value: CborValue): boolean {
  switch (value.type) {
    case "float":
      return Number.isNaN(value.value);
    case "array":
      return value.value.some((item) => containsNaN(item));
    case "map":
      return value.value.some(([key, entry]) => containsNaN(key) || containsNaN(entry));
    case "tag":
      return containsNaN(value.value);
    default:
      return false;
  }
}

/**
 * 浮動小数点数の符号付きゼロの符号を反転した複製を作る
 */
function flipZeroSign(value: CborValue): CborValue {
  switch (value.type) {
    case "float":
      return cborFloat(value.value === 0 ? -value.value : value.value);
    case "array":
      return cborArray(value.value.map((item) => flipZeroSign(item)));
    case "map":
      return cborMap(
        value.value.map(([key, entry]): [CborValue, CborValue] => [
          flipZeroSign(key),
          flipZeroSign(entry),
        ]),
      );
    case "tag":
      return cborTag(value.tag, flipZeroSign(value.value));
    case "byteString":
      return cborByteString(value.value.slice());
    default:
      return value;
  }
}

test("アクセサーは任意のデータ項目で例外を投げない", () => {
  fc.assert(
    fc.property(cborValueArbitrary(3), (value) => {
      const integer = cborAsInteger(value);
      if (integer !== undefined) {
        assert.equal(cborAsNumber(value), Number(integer));
      }
      // i64 の範囲外は整数として扱わない
      if (cborAsInt64(value) !== undefined) {
        assert.deepEqual(cborAsInt64(value), integer);
      }
      if (cborAsUnsigned(value) !== undefined) {
        assert.equal(value.type, "unsigned");
      }
      if (cborAsBytes(value) !== undefined) {
        assert.equal(value.type, "byteString");
      }
      if (cborAsText(value) !== undefined) {
        assert.equal(value.type, "textString");
      }
      if (cborAsArray(value) !== undefined) {
        assert.equal(value.type, "array");
      }
      if (cborAsMap(value) !== undefined) {
        assert.equal(value.type, "map");
      }
      if (cborAsBool(value) !== undefined) {
        assert.equal(value.type, "bool");
      }
    }),
  );

  // cborAsInt64 の境界は 2^63 - 1 である
  assert.notEqual(cborAsInt64(cborUnsigned(9223372036854775807n)), undefined);
  assert.equal(cborAsInt64(cborUnsigned(9223372036854775808n)), undefined);
  // タグや浮動小数点数は整数として扱わない
  assert.equal(cborAsInt64(cborTag(0n, cborUnsigned(1n))), undefined);
  assert.equal(cborAsInt64(cborFloat(1)), undefined);
});

test("ネスト深度の境界はデコードとエンコードで一致する", () => {
  fc.assert(
    fc.property(fc.integer({ min: 0, max: MAX_CBOR_DEPTH + 6 }), (depth) => {
      const bytes = new Uint8Array(depth + 1);
      bytes.fill(0x81, 0, depth);
      bytes[depth] = 0x01;
      let value: CborValue = cborUnsigned(1n);
      for (let level = 0; level < depth; level++) {
        value = cborArray([value]);
      }
      if (depth <= MAX_CBOR_DEPTH) {
        assert.deepEqual(decodeCbor(bytes), value);
        assert.deepEqual(encodeCbor(value), bytes);
        return;
      }
      assertCborError(() => decodeCbor(bytes), "depthLimitExceeded");
      assertCborError(() => encodeCbor(value), "depthLimitExceeded");
    }),
  );
});

test("cborMapGet は cborEquals で一致する最初の値を返す", () => {
  fc.assert(
    fc.property(
      fc.uniqueArray(fc.bigInt({ min: 0n, max: 100n }), { maxLength: 4, size: "max" }),
      fc.bigInt({ min: 0n, max: 100n }),
      (keys, searchKey) => {
        const entries = keys.map((key): [CborValue, CborValue] => [
          cborUnsigned(key),
          cborUnsigned(key + 1n),
        ]);
        const found = cborMapGet(cborMap(entries), cborUnsigned(searchKey));
        const expected = keys.includes(searchKey) ? cborUnsigned(searchKey + 1n) : undefined;
        assert.deepEqual(found, expected);
      },
    ),
  );
});
