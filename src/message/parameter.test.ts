/**
 * MOQT Parameter Unit Tests
 * draft-ietf-moq-transport-16 Section 9.2
 */

import { test, assert } from "vitest";
import {
  decodeSubscriptionFilter,
  decodeSubscriptionFilterParameter,
  encodeParameters,
  decodeParameters,
} from "./parameter";
import { encodeVarint } from "../varint";

test("無効なパラメータタイプでエラー", () => {
  const invalidParam = { type: 0x20, value: new Uint8Array([0x01]) };
  assert.throws(() => decodeSubscriptionFilterParameter(invalidParam), "Invalid parameter type");
});

test("無効なフィルタタイプでエラー", () => {
  const invalidData = new Uint8Array([0x10]);
  assert.throws(() => decodeSubscriptionFilter(invalidData), "Unknown filter type");
});

/**
 * delta encoding のテスト
 * draft-ietf-moq-transport-16 Section 9.2:
 * Key-Value-Pairs encode a Type value as a delta from the previous Type value,
 * or from 0 if there is no previous Type value.
 */
test("Parameters の delta encoding が正しくエンコードされる", () => {
  // type が [2, 4, 10] のパラメータリスト
  // delta type は [2, 2, 6] になるはず
  const params = [
    { type: 2, value: encodeVarint(100n) },
    { type: 4, value: encodeVarint(200n) },
    { type: 10, value: encodeVarint(300n) },
  ];

  const encoded = encodeParameters(params);

  // count = 3 (1 byte), 続いて各パラメータ
  // 先頭バイトは count = 3
  assert.equal(encoded[0], 3);

  // 最初のパラメータ: delta = 2 (0 から 2)
  // delta = 2, value = 100
  assert.equal(encoded[1], 2);

  // 2番目のパラメータ: delta = 2 (2 から 4)
  // value = 100 は 1 バイト (0x64) なので、次のパラメータは index 3 から
  // delta = 2, value = 200
  // 3番目のパラメータ: delta = 6 (4 から 10)
  // 詳細なバイト位置は varint エンコーディングに依存するので、
  // ラウンドトリップで検証
  const [decoded, consumed] = decodeParameters(encoded);
  assert.equal(decoded.length, 3);
  assert.equal(decoded[0].type, 2);
  assert.equal(decoded[1].type, 4);
  assert.equal(decoded[2].type, 10);
  assert.equal(consumed, encoded.length);
});

test("Parameters の delta encoding で type が昇順でない場合にエラー", () => {
  // type が降順の場合、delta が負になるためエラー
  const params = [
    { type: 10, value: encodeVarint(100n) },
    { type: 4, value: encodeVarint(200n) },
  ];

  assert.throws(() => encodeParameters(params), /delta type must be non-negative/);
});

test("空の Parameters リストのエンコード・デコード", () => {
  const params: { type: number; value: Uint8Array }[] = [];
  const encoded = encodeParameters(params);
  const [decoded, consumed] = decodeParameters(encoded);

  assert.equal(decoded.length, 0);
  assert.equal(consumed, encoded.length);
});
