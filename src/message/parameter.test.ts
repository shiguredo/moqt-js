/**
 * MOQT Parameter Unit Tests
 * draft-ietf-moq-transport-16 Section 9.2
 */

import { test, assert } from "vitest";
import {
  createTrackNamespace,
  decodeSubscriptionFilter,
  decodeSubscriptionFilterParameter,
  decodeTrackNamespace,
  encodeParameters,
  decodeParameters,
  encodeTrackName,
  encodeTrackNamespace,
  validateTrackNameSize,
  MAX_TRACK_NAME_SIZE,
  MAX_TRACK_NAMESPACE_SIZE,
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

/**
 * Track Namespace / Full Track Name のサイズ制限テスト
 * draft-ietf-moq-transport-16:
 * Track Namespace と Full Track Name は最大 4,096 バイト。
 * https://github.com/moq-wg/moq-transport/pull/1399
 */
test("Track Namespace のサイズ制限定数が 4,096", () => {
  assert.equal(MAX_TRACK_NAMESPACE_SIZE, 4096);
});

test("Track Name のサイズ制限定数が 4,096", () => {
  assert.equal(MAX_TRACK_NAME_SIZE, 4096);
});

test("createTrackNamespace で制限を超えるとエラー", () => {
  // 各要素が 2,000 バイトで、3 要素 = 6,000 バイト > 4,096
  const largePart = "a".repeat(2000);
  assert.throws(
    () => createTrackNamespace([largePart, largePart, largePart]),
    /track namespace exceeds maximum size/,
  );
});

test("createTrackNamespace で制限内なら成功", () => {
  // 各要素が 1,000 バイトで、4 要素 = 4,000 バイト < 4,096
  const mediumPart = "a".repeat(1000);
  const ns = createTrackNamespace([mediumPart, mediumPart, mediumPart, mediumPart]);
  assert.equal(ns.tuple.length, 4);
});

test("encodeTrackNamespace で制限を超えるとエラー", () => {
  // 直接 Uint8Array で 5,000 バイトの要素を作成
  const largeElement = new Uint8Array(5000);
  assert.throws(
    () => encodeTrackNamespace({ tuple: [largeElement] }),
    /track namespace exceeds maximum size/,
  );
});

test("decodeTrackNamespace で制限を超えるとエラー", () => {
  // 要素数 1、長さ 5,000 のデータを作成
  const countBytes = encodeVarint(1n);
  const lengthBytes = encodeVarint(5000n);
  const dataBytes = new Uint8Array(5000);

  const encoded = new Uint8Array(countBytes.length + lengthBytes.length + dataBytes.length);
  encoded.set(countBytes, 0);
  encoded.set(lengthBytes, countBytes.length);
  encoded.set(dataBytes, countBytes.length + lengthBytes.length);

  assert.throws(() => decodeTrackNamespace(encoded), /track namespace exceeds maximum size/);
});

test("encodeTrackName で制限を超えるとエラー", () => {
  const largeName = "a".repeat(5000);
  assert.throws(() => encodeTrackName(largeName), /track name exceeds maximum size/);
});

test("encodeTrackName で制限内なら成功", () => {
  const normalName = "a".repeat(4000);
  const bytes = encodeTrackName(normalName);
  assert.equal(bytes.length, 4000);
});

test("validateTrackNameSize で制限を超えるとエラー", () => {
  const largeBytes = new Uint8Array(5000);
  assert.throws(() => validateTrackNameSize(largeBytes), /track name exceeds maximum size/);
});

test("validateTrackNameSize で制限内なら成功", () => {
  const normalBytes = new Uint8Array(4000);
  // エラーが投げられなければ成功
  validateTrackNameSize(normalBytes);
});
