/**
 * CBOR (RFC 8949) のコーデックの Property-Based Testing
 *
 * 決定論的エンコードの性質 (往復・安定性) を、任意のデータ項目で確認する。
 */

import { test, assert } from "vite-plus/test";
import * as fc from "fast-check";
import {
  CBOR_FALSE,
  CBOR_NULL,
  CBOR_TRUE,
  CBOR_UNDEFINED,
  type CborValue,
  CborError,
  cborArray,
  cborByteString,
  cborFloat,
  cborMap,
  cborNegative,
  cborSimple,
  cborTag,
  cborTextString,
  cborUnsigned,
  decodeCbor,
  encodeCbor,
} from "./cbor";

/** 生成するデータ項目のネスト深度の上限 */
const MAX_TEST_DEPTH = 4;

/** 単純値の生成 (予約された 20 〜 31 は除く) */
const simpleArbitrary = fc.oneof(
  fc.integer({ min: 0, max: 19 }).map((value) => cborSimple(value)),
  fc.integer({ min: 32, max: 255 }).map((value) => cborSimple(value)),
);

/**
 * データ項目を生成する Arbitrary
 *
 * マップのキーは重複しない符号なし整数にする (重複キーはエラーになるため)。
 * テキスト文字列は grapheme 単位で生成し、UTF-8 として不正な文字列を含めない。
 */
function valueArbitrary(depth: number): fc.Arbitrary<CborValue> {
  const leaf = fc.oneof(
    fc.bigInt({ min: 0n, max: 18446744073709551615n }).map((value) => cborUnsigned(value)),
    fc.bigInt({ min: 0n, max: 18446744073709551615n }).map((value) => cborNegative(value)),
    fc.uint8Array({ maxLength: 16 }).map((value) => cborByteString(value)),
    fc.string({ unit: "grapheme", maxLength: 16 }).map((value) => cborTextString(value)),
    fc.double().map((value) => cborFloat(value)),
    fc.constantFrom(CBOR_NULL, CBOR_UNDEFINED, CBOR_TRUE, CBOR_FALSE),
    simpleArbitrary,
  );
  if (depth <= 0) {
    return leaf;
  }
  const mapArbitrary = fc
    .uniqueArray(fc.tuple(fc.bigInt({ min: 0n, max: 1000n }), valueArbitrary(depth - 1)), {
      selector: (entry) => entry[0].toString(),
      maxLength: 3,
    })
    .map((entries) =>
      // 決定論的エンコードはキーを昇順に並べるため、生成時点でも昇順にする
      entries
        .slice()
        .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0))
        .map(([key, value]) => [cborUnsigned(key), value] as [CborValue, CborValue]),
    )
    .map((entries) => cborMap(entries));
  return fc.oneof(
    { weight: 4, arbitrary: leaf },
    {
      weight: 1,
      arbitrary: fc
        .array(valueArbitrary(depth - 1), { maxLength: 3 })
        .map((items) => cborArray(items)),
    },
    { weight: 1, arbitrary: mapArbitrary },
    {
      weight: 1,
      arbitrary: fc.tuple(valueArbitrary(depth - 1)).map(([value]) => cborTag(100n, value)),
    },
  );
}

test("エンコードとデコードは往復する", () => {
  fc.assert(
    fc.property(valueArbitrary(MAX_TEST_DEPTH), (value) => {
      const encoded = encodeCbor(value);
      assert.deepEqual(decodeCbor(encoded), value);
    }),
  );
});

test("一度エンコードしたデータ項目は再エンコードしても同じバイト列になる", () => {
  fc.assert(
    fc.property(valueArbitrary(MAX_TEST_DEPTH), (value) => {
      const encoded = encodeCbor(value);
      const decoded = decodeCbor(encoded);
      assert.deepEqual(encodeCbor(decoded), encoded);
    }),
  );
});

test("任意のバイト列はデコードできるか CborError になり、デコードできた場合はエンコードが安定する", () => {
  fc.assert(
    fc.property(fc.uint8Array({ maxLength: 64 }), (bytes) => {
      let decoded: CborValue;
      try {
        decoded = decodeCbor(bytes);
      } catch (error) {
        assert.ok(
          error instanceof CborError,
          `CborError を期待したが ${String(error)} が送出された`,
        );
        return;
      }
      const encoded = encodeCbor(decoded);
      const reDecoded = decodeCbor(encoded);
      assert.deepEqual(encodeCbor(reDecoded), encoded);
    }),
  );
});
