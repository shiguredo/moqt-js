/**
 * CBOR (RFC 8949) のコーデックのテスト
 *
 * テストベクタは draft-ietf-moq-c4m-01 付録 A.2 の CBOR バイト列を使う。
 */

import { test, assert } from "vite-plus/test";
import {
  CBOR_FALSE,
  CBOR_NULL,
  CBOR_TRUE,
  CBOR_UNDEFINED,
  MAX_CBOR_DEPTH,
  type CborValue,
  cborArray,
  cborAsArray,
  cborAsBool,
  cborAsBytes,
  cborAsInteger,
  cborAsMap,
  cborAsNumber,
  cborAsText,
  cborAsUnsigned,
  cborBool,
  cborByteString,
  cborFloat,
  cborInteger,
  cborMap,
  cborMapGet,
  cborNegative,
  cborSimple,
  cborTag,
  cborTextString,
  cborUnsigned,
  decodeCbor,
  decodeCborPartial,
  encodeCbor,
} from "./cbor";
import { assertCborError, decodeHex, encodeHex } from "./testSupport";
import { CLAIM_VECTORS } from "./testVectors";

test("付録 A.2 のベクタをデコードして再エンコードすると同じバイト列になる", () => {
  for (const vector of CLAIM_VECTORS) {
    const bytes = decodeHex(vector.payloadHex);
    const value = decodeCbor(bytes);
    const encoded = encodeCbor(value);
    assert.equal(encodeHex(encoded), vector.payloadHex, `ベクタ ${vector.id} の再エンコード`);
  }
});

test("issuer のみのベクタは期待した構造を持つ", () => {
  const value = decodeCbor(decodeHex(CLAIM_VECTORS[0]?.payloadHex ?? ""));
  assert.deepEqual(
    value,
    cborMap([[cborUnsigned(1n), cborTextString("https://auth.example.com")]]),
  );
});

test("decodeCborPartial は消費したバイト数を返す", () => {
  const bytes = decodeHex(CLAIM_VECTORS[0]?.payloadHex ?? "");
  const extended = new Uint8Array([...bytes, 0xff]);
  const { value, consumed } = decodeCborPartial(extended);
  // 余分なバイトがあっても先頭のデータ項目を読める
  assert.equal(value.type, "map");
  assert.equal(consumed, extended.length - 1);
  // 全体をデコードする API は余分なバイトを拒否する
  assertCborError(() => decodeCbor(extended), "trailingBytes");
});

test("符号なし整数は最小の長さでエンコードする", () => {
  assert.deepEqual(encodeCbor(cborUnsigned(0n)), new Uint8Array([0x00]));
  assert.deepEqual(encodeCbor(cborUnsigned(23n)), new Uint8Array([0x17]));
  assert.deepEqual(encodeCbor(cborUnsigned(24n)), new Uint8Array([0x18, 0x18]));
  assert.deepEqual(encodeCbor(cborUnsigned(255n)), new Uint8Array([0x18, 0xff]));
  assert.deepEqual(encodeCbor(cborUnsigned(256n)), new Uint8Array([0x19, 0x01, 0x00]));
  assert.deepEqual(
    encodeCbor(cborUnsigned(65536n)),
    new Uint8Array([0x1a, 0x00, 0x01, 0x00, 0x00]),
  );
  assert.deepEqual(
    encodeCbor(cborUnsigned(18446744073709551615n)),
    new Uint8Array([0x1b, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]),
  );
});

test("負の整数は最小の長さでエンコードする", () => {
  assert.deepEqual(encodeCbor(cborInteger(-1n)), new Uint8Array([0x20]));
  assert.deepEqual(encodeCbor(cborInteger(-24n)), new Uint8Array([0x37]));
  assert.deepEqual(encodeCbor(cborInteger(-25n)), new Uint8Array([0x38, 0x18]));
  assert.deepEqual(
    encodeCbor(cborInteger(-9223372036854775808n)),
    new Uint8Array([0x3b, 0x7f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]),
  );
  assert.deepEqual(cborInteger(-1n), cborNegative(0n));
  assert.equal(cborAsInteger(cborInteger(-1n)), -1n);
});

test("4 バイト引数の値は 2^31 以上でも符号なしで読む", () => {
  // JavaScript のビット演算は符号付き 32 ビットのため、2^31 以上が負にならないことを固定する
  assert.deepEqual(decodeCbor(decodeHex("1a80000000")), cborUnsigned(2147483648n));
  assert.deepEqual(decodeCbor(decodeHex("1affffffff")), cborUnsigned(4294967295n));
  assert.deepEqual(decodeCbor(decodeHex("3a80000000")), cborNegative(2147483648n));
  assert.deepEqual(decodeCbor(decodeHex("3affffffff")), cborNegative(4294967295n));
  assert.equal(cborAsInteger(decodeCbor(decodeHex("3a80000000"))), -2147483649n);
  // デコードした値は元のバイト列へ再エンコードできる
  assert.equal(encodeHex(encodeCbor(decodeCbor(decodeHex("1affffffff")))), "1affffffff");
  assert.equal(encodeHex(encodeCbor(decodeCbor(decodeHex("3affffffff")))), "3affffffff");
});

test("4 バイト引数のタグは 2^31 以上でも保持される", () => {
  const value = decodeCbor(decodeHex("daffffffff00"));
  assert.deepEqual(value, cborTag(4294967295n, cborUnsigned(0n)));
  assert.equal(encodeHex(encodeCbor(value)), "daffffffff00");
});

test("4 バイト引数の長さが 2^31 以上のときは unexpectedEof になる", () => {
  // 2^31 は Number.MAX_SAFE_INTEGER 未満のため長さの変換は成功し、本体を読むところで
  // 入力が尽きて unexpectedEof になる
  assertCborError(() => decodeCbor(decodeHex("5a80000000")), "unexpectedEof");
  assertCborError(() => decodeCbor(decodeHex("7a80000000")), "unexpectedEof");
  assertCborError(() => decodeCbor(decodeHex("9a80000000")), "unexpectedEof");
  assertCborError(() => decodeCbor(decodeHex("ba80000000")), "unexpectedEof");
});

test("浮動小数点数は値を保つ最短の幅でエンコードする", () => {
  // 付録 A.2 / A.5 のベクタに出てくる値
  assert.deepEqual(encodeCbor(cborFloat(100)), decodeHex("f95640"));
  assert.deepEqual(encodeCbor(cborFloat(300)), decodeHex("f95cb0"));
  assert.deepEqual(encodeCbor(cborFloat(37.7749)), decodeHex("fb4042e32fec56d5d0"));
  assert.deepEqual(encodeCbor(cborFloat(-122.4194)), decodeHex("fbc05e9ad77318fc50"));
  // 半精度の境界と特殊値
  assert.deepEqual(encodeCbor(cborFloat(65504)), decodeHex("f97bff"));
  assert.deepEqual(encodeCbor(cborFloat(1.5)), decodeHex("f93e00"));
  assert.deepEqual(encodeCbor(cborFloat(-0)), decodeHex("f98000"));
  assert.deepEqual(encodeCbor(cborFloat(Infinity)), decodeHex("f97c00"));
  assert.deepEqual(encodeCbor(cborFloat(-Infinity)), decodeHex("f9fc00"));
  assert.deepEqual(encodeCbor(cborFloat(Number.NaN)), decodeHex("f97e00"));
  // 半精度で表現できない値は単精度 / 倍精度になる
  assert.deepEqual(encodeCbor(cborFloat(100000)), decodeHex("fa47c35000"));
  assert.deepEqual(encodeCbor(cborFloat(0.1)), decodeHex("fb3fb999999999999a"));
});

test("浮動小数点数はすべての幅でデコードできる", () => {
  // 付録 A.2 の accuracy は f9 5640 (100.0) で書かれている
  assert.deepEqual(decodeCbor(decodeHex("f95640")), cborFloat(100));
  // 半精度の別値 (0x5664 は 102.25) も正しく読める
  assert.deepEqual(decodeCbor(decodeHex("f95664")), cborFloat(102.25));
  assert.deepEqual(decodeCbor(decodeHex("fa47c35000")), cborFloat(100000));
  assert.deepEqual(decodeCbor(decodeHex("fb3fb999999999999a")), cborFloat(0.1));
  assert.deepEqual(decodeCbor(decodeHex("f97c00")), cborFloat(Infinity));
  assert.deepEqual(decodeCbor(decodeHex("f9fc00")), cborFloat(-Infinity));
  const nan = decodeCbor(decodeHex("f97e00"));
  assert.ok(nan.type === "float" && Number.isNaN(nan.value));
  // -0.0 は符号を保つ
  const negativeZero = decodeCbor(decodeHex("f98000"));
  assert.ok(
    negativeZero.type === "float" && Object.is(negativeZero.value, -0),
    "-0.0 の符号が保たれる",
  );
});

test("バイト文字列とテキスト文字列は往復する", () => {
  const value = cborMap([
    [cborUnsigned(1n), cborByteString(new Uint8Array([0x00, 0xff]))],
    [cborUnsigned(2n), cborTextString("こんにちは")],
  ]);
  const encoded = encodeCbor(value);
  assert.deepEqual(decodeCbor(encoded), value);
});

test("indefinite 長のデータ項目をデコードできる", () => {
  // indefinite 長のバイト文字列
  assert.deepEqual(
    decodeCbor(decodeHex("5f42010243030405ff")),
    cborByteString(new Uint8Array([1, 2, 3, 4, 5])),
  );
  // indefinite 長のテキスト文字列
  assert.deepEqual(decodeCbor(decodeHex("7f616161626163ff")), cborTextString("abc"));
  // indefinite 長の配列
  assert.deepEqual(
    decodeCbor(decodeHex("9f0102ff")),
    cborArray([cborUnsigned(1n), cborUnsigned(2n)]),
  );
  // indefinite 長のマップ
  assert.deepEqual(
    decodeCbor(decodeHex("bf01020304ff")),
    cborMap([
      [cborUnsigned(1n), cborUnsigned(2n)],
      [cborUnsigned(3n), cborUnsigned(4n)],
    ]),
  );
});

test("indefinite 長のエラーを拒否する", () => {
  // break が単独で現れる
  assertCborError(() => decodeCbor(new Uint8Array([0xff])), "breakOutsideIndefinite");
  // indefinite チャンクの型が違う
  assertCborError(() => decodeCbor(decodeHex("5f6101ff")), "invalidIndefiniteChunk");
  // indefinite チャンクに indefinite は書けない
  assertCborError(() => decodeCbor(decodeHex("5f5f4101ffff")), "invalidAdditionalInformation", 31);
});

test("マップのキーはエンコード済みバイト列の昇順に並ぶ", () => {
  const value = cborMap([
    [cborTextString("aa"), cborUnsigned(3n)],
    [cborUnsigned(10n), cborUnsigned(2n)],
    [cborUnsigned(2n), cborUnsigned(1n)],
  ]);
  assert.equal(encodeHex(encodeCbor(value)), "a302010a0262616103");
});

test("重複するマップキーはデコードとエンコードの両方で拒否する", () => {
  assertCborError(() => decodeCbor(decodeHex("a201010102")), "duplicateMapKey");
  const value = cborMap([
    [cborUnsigned(1n), cborUnsigned(1n)],
    [cborUnsigned(1n), cborUnsigned(2n)],
  ]);
  assertCborError(() => encodeCbor(value), "duplicateMapKey");
});

test("不正な入力を拒否する", () => {
  assertCborError(() => decodeCbor(new Uint8Array(0)), "unexpectedEof");
  assertCborError(() => decodeCbor(new Uint8Array([0x18])), "unexpectedEof");
  assertCborError(() => decodeCbor(decodeHex("1a800000")), "unexpectedEof");
  assertCborError(() => decodeCbor(new Uint8Array([0x1c])), "invalidAdditionalInformation", 28);
  assertCborError(() => decodeCbor(new Uint8Array([0xf8, 0x1f])), "invalidSimpleValue", 31);
  assertCborError(() => decodeCbor(decodeHex("61ff")), "invalidUtf8");
});

test("単純値と特殊値を往復できる", () => {
  assert.deepEqual(decodeCbor(new Uint8Array([0xf4])), CBOR_FALSE);
  assert.deepEqual(decodeCbor(new Uint8Array([0xf5])), CBOR_TRUE);
  assert.deepEqual(decodeCbor(new Uint8Array([0xf6])), CBOR_NULL);
  assert.deepEqual(decodeCbor(new Uint8Array([0xf7])), CBOR_UNDEFINED);
  assert.deepEqual(decodeCbor(new Uint8Array([0xf8, 0x20])), cborSimple(32));
  assert.deepEqual(encodeCbor(CBOR_TRUE), new Uint8Array([0xf5]));
  assert.deepEqual(encodeCbor(CBOR_NULL), new Uint8Array([0xf6]));
  assert.deepEqual(encodeCbor(CBOR_UNDEFINED), new Uint8Array([0xf7]));
  assert.deepEqual(encodeCbor(cborSimple(32)), new Uint8Array([0xf8, 0x20]));
  assert.deepEqual(encodeCbor(cborSimple(5)), new Uint8Array([0xe5]));
  assertCborError(() => encodeCbor(cborSimple(25)), "invalidSimpleValue", 25);
});

test("タグは保持される", () => {
  const value = decodeCbor(decodeHex("d83dd8184101"));
  assert.deepEqual(value, cborTag(61n, cborTag(24n, cborByteString(new Uint8Array([1])))));
  assert.equal(encodeHex(encodeCbor(value)), "d83dd8184101");
});

test("ネスト深度の上限はデコードとエンコードの両方で適用される", () => {
  // 上限ちょうどは通る
  const bytes = new Uint8Array(MAX_CBOR_DEPTH + 1);
  bytes.fill(0x81, 0, MAX_CBOR_DEPTH);
  bytes[MAX_CBOR_DEPTH] = 0x01;
  let expected = cborUnsigned(1n);
  for (let depth = 0; depth < MAX_CBOR_DEPTH; depth++) {
    expected = cborArray([expected]);
  }
  assert.deepEqual(decodeCbor(bytes), expected);
  // 上限を超えるとエラー
  const tooDeep = new Uint8Array(MAX_CBOR_DEPTH + 2);
  tooDeep.fill(0x81, 0, MAX_CBOR_DEPTH + 1);
  tooDeep[MAX_CBOR_DEPTH + 1] = 0x01;
  assertCborError(() => decodeCbor(tooDeep), "depthLimitExceeded");

  let value = cborUnsigned(1n);
  for (let depth = 0; depth < MAX_CBOR_DEPTH + 1; depth++) {
    value = cborArray([value]);
  }
  assertCborError(() => encodeCbor(value), "depthLimitExceeded");
});

test("アクセサーで値を取り出せる", () => {
  const map = cborMap([
    [cborUnsigned(1n), cborTextString("a")],
    [cborInteger(-1n), cborFloat(1.5)],
    [cborUnsigned(2n), cborByteString(new Uint8Array([7]))],
    [cborUnsigned(3n), cborBool(true)],
  ]);
  assert.equal(cborAsText(cborMapGet(map, cborUnsigned(1n)) ?? CBOR_NULL), "a");
  assert.equal(cborAsNumber(cborMapGet(map, cborInteger(-1n)) ?? CBOR_NULL), 1.5);
  assert.deepEqual(
    cborAsBytes(cborMapGet(map, cborUnsigned(2n)) ?? CBOR_NULL),
    new Uint8Array([7]),
  );
  assert.equal(cborAsBool(cborMapGet(map, cborUnsigned(3n)) ?? CBOR_NULL), true);
  assert.equal(cborAsUnsigned(cborUnsigned(1n)), 1n);
  assert.equal(cborAsUnsigned(cborNegative(0n)), undefined);
  assert.deepEqual(cborAsArray(cborArray([])), []);
  assert.equal(cborAsMap(cborUnsigned(1n)), undefined);
});

test("2^53 を超える負の整数も 1 回だけ丸めて number へ変換する", () => {
  assert.equal(cborAsNumber(cborInteger(-9412508413557840n)), -9412508413557840);
  assert.equal(cborAsNumber(cborNegative(9412508413557839n)), -9412508413557840);
  // 64 ビットの最大値も 1 回だけ丸める
  assert.equal(cborAsNumber(cborNegative(18446744073709551615n)), Number(-18446744073709551616n));
});

test("indefinite 長のテキストチャンクはそれぞれ UTF-8 として正しくなければならない", () => {
  // チャンクを連結すると "€" (e2 82 ac) になるが、RFC 8949 Section 3.2.3 は
  // 各チャンクが個別に正しい UTF-8 であることを要求する
  assertCborError(() => decodeCbor(decodeHex("7f62e28261acff")), "invalidUtf8");
  // 1 チャンクに収まっていれば通る
  assert.deepEqual(decodeCbor(decodeHex("7f63e282acff")), cborTextString("€"));
});

test("NaN の重複キーを拒否する", () => {
  // RFC 8949 Section 5.6.1 は同じ内容の NaN のキーを同一視する
  const value = cborMap([
    [cborFloat(Number.NaN), cborUnsigned(1n)],
    [cborFloat(Number.NaN), cborUnsigned(2n)],
  ]);
  assertCborError(() => encodeCbor(value), "duplicateMapKey");
  assertCborError(() => decodeCbor(decodeHex("a2f97e0001f97e0002")), "duplicateMapKey");
});

test("大きなマップでも重複キーを検出する", () => {
  // 重複検査が二次関数的な時間を使わないことを、大きなマップで確認する
  const entries: Array<[CborValue, CborValue]> = [];
  for (let index = 0n; index < 2000n; index++) {
    entries.push([cborUnsigned(index), cborUnsigned(index)]);
  }
  entries.push([cborUnsigned(1000n), cborUnsigned(1000n)]);
  assertCborError(() => encodeCbor(cborMap(entries)), "duplicateMapKey");
});

test("0.0 と -0.0 のキーは等価として扱う", () => {
  // RFC 8949 Section 5.6.1: -0.0 と 0.0 は数値として等しいため同一のキー
  const value = cborMap([
    [cborFloat(0), cborUnsigned(1n)],
    [cborFloat(-0), cborUnsigned(2n)],
  ]);
  assertCborError(() => encodeCbor(value), "duplicateMapKey");
  assertCborError(() => decodeCbor(decodeHex("a2f9000001f9800002")), "duplicateMapKey");
  // 片方だけなら通る
  assert.doesNotThrow(() => encodeCbor(cborMap([[cborFloat(-0), cborUnsigned(1n)]])));
});

test("入れ子のキーも正規化してから比較する", () => {
  // 入れ子のキーでも -0.0 と 0.0 は同一視する
  const value = cborMap([
    [cborArray([cborFloat(0)]), cborUnsigned(1n)],
    [cborArray([cborFloat(-0)]), cborUnsigned(2n)],
  ]);
  assertCborError(() => encodeCbor(value), "duplicateMapKey");

  // 深すぎるキーはスタックを壊さず depthLimitExceeded になる
  let key = cborUnsigned(1n);
  for (let depth = 0; depth < MAX_CBOR_DEPTH + 2; depth++) {
    key = cborArray([key]);
  }
  assertCborError(() => encodeCbor(cborMap([[key, cborUnsigned(1n)]])), "depthLimitExceeded");
});
