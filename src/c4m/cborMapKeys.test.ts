/**
 * CBOR マップのキーの正規化と重複判定のテスト
 *
 * ワイヤ経路 (`./cbor`) と、手組みの `CborValue` を直接受ける公開 API
 * (`./cat` / `./moqt`) が共有する判定を直接固定する。モックは使わない。
 */

import { test, assert } from "vite-plus/test";
import {
  type CborValue,
  CborError,
  cborArray,
  cborFloat,
  cborInteger,
  cborMap,
  cborSimple,
  cborTag,
  cborTextString,
  encodeCbor,
} from "./cbor";
import { MAX_CBOR_DEPTH } from "./cborError";
import { findDuplicateMapKey, hasDuplicateMapKeys, normalizeCborKey } from "./cborMapKeys";

/**
 * 配列を `depth` 段ネストしたデータ項目を作る
 *
 * 一番内側の整数は深さ `depth` にある。
 */
function nestedArray(depth: number): CborValue {
  let value: CborValue = cborInteger(0);
  for (let index = 0; index < depth; index++) {
    value = cborArray([value]);
  }
  return value;
}

/**
 * `depthLimitExceeded` を送出することを確認する
 */
function assertDepthLimitExceeded(run: () => unknown): void {
  let thrown: unknown;
  try {
    run();
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof CborError, `CborError を期待したが ${String(thrown)} が送出された`);
  assert.equal(thrown.code, "depthLimitExceeded");
}

test("normalizeCborKey は -0.0 を 0.0 に正規化し、NaN はそのまま保持する", () => {
  // RFC 8949 Section 5.6.1 のキーの等価性に合わせ、数値として等しい -0.0 と 0.0 を
  // 同じキーにする。NaN は実装判断ですべて同一視するため、値は変えずに保持する
  assert.deepEqual(normalizeCborKey(cborFloat(-0), 0), cborFloat(0));
  const normalizedNaN = normalizeCborKey(cborFloat(Number.NaN), 0);
  assert.equal(normalizedNaN.type, "float");
  assert.ok(normalizedNaN.type === "float" && Number.isNaN(normalizedNaN.value));
});

test("normalizeCborKey は配列・マップ・タグの中を再帰的に正規化する", () => {
  // キーと値の両方に -0.0 を置き、配列 / マップ / タグの内側まで正規化されることを
  // 確認する。マップのエントリの順序はこの関数では変えない (並べ替えはエンコード側)
  const value = cborMap([
    [
      cborArray([cborFloat(-0)]),
      cborMap([
        [cborTextString("nested"), cborTag(61n, cborFloat(-0))],
        [cborFloat(-0), cborArray([cborFloat(-0)])],
      ]),
    ],
    [cborTag(24n, cborMap([[cborFloat(-0), cborFloat(-0)]])), cborInteger(1)],
  ]);
  assert.deepEqual(
    normalizeCborKey(value, 0),
    cborMap([
      [
        cborArray([cborFloat(0)]),
        cborMap([
          [cborTextString("nested"), cborTag(61n, cborFloat(0))],
          [cborFloat(0), cborArray([cborFloat(0)])],
        ]),
      ],
      [cborTag(24n, cborMap([[cborFloat(0), cborFloat(0)]])), cborInteger(1)],
    ]),
  );
});

test("normalizeCborKey は深さ上限ちょうどを受け付け、超えたら depthLimitExceeded にする", () => {
  // 深さ MAX_CBOR_DEPTH のネストは受理する
  assert.deepEqual(normalizeCborKey(nestedArray(MAX_CBOR_DEPTH), 0), nestedArray(MAX_CBOR_DEPTH));
  // 1 段深いネストは再帰の途中で上限を超えるため拒否する
  assertDepthLimitExceeded(() => normalizeCborKey(nestedArray(MAX_CBOR_DEPTH + 1), 0));
  // 呼び出し側が開始深度を指定した場合も、開始深度が上限を超えていれば拒否する
  assertDepthLimitExceeded(() => normalizeCborKey(cborInteger(0), MAX_CBOR_DEPTH + 1));
});

test("findDuplicateMapKey は重複が無いマップに対して undefined を返す", () => {
  const entries: Array<[CborValue, CborValue]> = [
    [cborInteger(1), cborTextString("one")],
    [cborInteger(2), cborTextString("two")],
    [cborTextString("three"), cborInteger(3)],
  ];
  assert.equal(findDuplicateMapKey(entries, encodeCbor), undefined);
  assert.isFalse(hasDuplicateMapKeys(entries, encodeCbor));
});

test("findDuplicateMapKey は同じ整数キーとテキストキーの重複を検出する", () => {
  // 返す値は入力のキーそのものであり、エラーの詳細に使える
  const integerKey = cborInteger(1000);
  assert.deepEqual(
    findDuplicateMapKey(
      [
        [integerKey, cborTextString("first")],
        [cborInteger(1000), cborTextString("second")],
      ],
      encodeCbor,
    ),
    integerKey,
  );

  const textKey = cborTextString("custom");
  assert.deepEqual(
    findDuplicateMapKey(
      [
        [textKey, cborInteger(1)],
        [cborTextString("custom"), cborInteger(2)],
      ],
      encodeCbor,
    ),
    textKey,
  );
  assert.isTrue(
    hasDuplicateMapKeys(
      [
        [textKey, cborInteger(1)],
        [cborTextString("custom"), cborInteger(2)],
      ],
      encodeCbor,
    ),
  );
});

test("findDuplicateMapKey は -0.0 と 0.0、NaN 同士を同じキーとして検出する", () => {
  // データ項目としての等価性ではなく、正規化して決定論的にエンコードした
  // バイト列で比較する (RFC 8949 Section 5.6.1)
  const secondZeroKey = cborFloat(0);
  assert.deepEqual(
    findDuplicateMapKey(
      [
        [cborFloat(-0), cborInteger(1)],
        [secondZeroKey, cborInteger(2)],
      ],
      encodeCbor,
    ),
    secondZeroKey,
  );

  // NaN はすべて同一視する。異なる NaN のビット列でも同じキーになる
  const nanKey = cborFloat(Number.NaN);
  assert.deepEqual(
    findDuplicateMapKey(
      [
        [nanKey, cborInteger(1)],
        [nanKey, cborInteger(2)],
      ],
      encodeCbor,
    ),
    nanKey,
  );
});

test("findDuplicateMapKey はエントリの順序だけが違うマップキーを重複として検出する", () => {
  // 決定論的エンコードはマップのキーを並べ替えるため、同じ内容のマップは
  // エントリの順序に関係なく同じバイト列になる
  const left = cborMap([
    [cborInteger(1), cborInteger(2)],
    [cborInteger(3), cborInteger(4)],
  ]);
  const right = cborMap([
    [cborInteger(3), cborInteger(4)],
    [cborInteger(1), cborInteger(2)],
  ]);
  assert.deepEqual(
    findDuplicateMapKey(
      [
        [left, cborInteger(1)],
        [right, cborInteger(2)],
      ],
      encodeCbor,
    ),
    right,
  );
});

test("findDuplicateMapKey はエンコードできないキーを比較の対象から外す", () => {
  // ワイヤ上のマップには現れないキー (simple value 20 は予約済み) はエンコードに
  // 失敗する。この関数は手組みの CborValue に対する保険として、そのキーを
  // 比較の対象から外し、他のキーの判定を続ける
  const unsupportedKey = cborSimple(20);
  assert.equal(
    findDuplicateMapKey(
      [
        [unsupportedKey, cborInteger(1)],
        [cborInteger(1), cborInteger(2)],
      ],
      encodeCbor,
    ),
    undefined,
  );
});
