/**
 * MOQT Parameter Unit Tests
 * draft-ietf-moq-transport-18 Section 10.2 (Message Parameter)
 */

import { test, assert } from "vite-plus/test";
import {
  createTrackNamespace,
  decodeSubscriptionFilter,
  decodeSubscriptionFilterParameter,
  decodeTrackNamespace,
  encodeParameters,
  decodeParameters,
  encodeUint8ParameterValue,
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
 * draft-ietf-moq-transport-18 Section 1.4.3 (Key-Value-Pair Structure):
 * https://www.ietf.org/archive/id/draft-ietf-moq-transport-18.html#section-1.4.3
 * Key-Value-Pairs encode a Type value as a delta from the previous Type value,
 * or from 0 if there is no previous Type value.
 */
test("Parameters の delta encoding が正しくエンコードされる", () => {
  // type が [0x02, 0x04, 0x08] のパラメータリスト (全て varint 型)
  // delta type は [2, 2, 4] になるはず
  const params = [
    { type: 0x02, value: encodeVarint(100n) },
    { type: 0x04, value: encodeVarint(200n) },
    { type: 0x08, value: encodeVarint(300n) },
  ];

  const encoded = encodeParameters(params);

  // count = 3 (1 byte), 続いて各パラメータ
  // 先頭バイトは count = 3
  assert.equal(encoded[0], 3);

  // 最初のパラメータ: delta = 2 (0 から 0x02)
  // delta = 2, value = 100
  assert.equal(encoded[1], 2);

  // 詳細なバイト位置は varint エンコーディングに依存するので、
  // ラウンドトリップで検証
  const [decoded, consumed] = decodeParameters(encoded);
  assert.equal(decoded.length, 3);
  assert.equal(decoded[0].type, 0x02);
  assert.equal(decoded[1].type, 0x04);
  assert.equal(decoded[2].type, 0x08);
  assert.equal(consumed, encoded.length);
});

test("Parameters の delta encoding で type が昇順でない場合もソートされる", () => {
  // encodeParameters は内部でソートするため、降順でもエラーにならない
  const params = [
    { type: 0x08, value: encodeVarint(100n) },
    { type: 0x02, value: encodeVarint(200n) },
  ];

  const encoded = encodeParameters(params);
  const [decoded, consumed] = decodeParameters(encoded);

  // ソートされて type 昇順になる
  assert.equal(decoded.length, 2);
  assert.equal(decoded[0].type, 0x02);
  assert.equal(decoded[1].type, 0x08);
  assert.equal(consumed, encoded.length);
});

test("空の Parameters リストのエンコード・デコード", () => {
  const params: { type: number; value: Uint8Array }[] = [];
  const encoded = encodeParameters(params);
  const [decoded, consumed] = decodeParameters(encoded);

  assert.equal(decoded.length, 0);
  assert.equal(consumed, encoded.length);
});

test("uint8 Message Parameter Value を 1 バイトでエンコードする", () => {
  const params = [
    { type: 0x10, value: encodeUint8ParameterValue(1, "FORWARD") },
    { type: 0x20, value: encodeUint8ParameterValue(255, "SUBSCRIBER_PRIORITY") },
    { type: 0x22, value: encodeUint8ParameterValue(2, "GROUP_ORDER") },
  ];

  const encoded = encodeParameters(params);

  assert.deepEqual([...encoded], [3, 0x10, 1, 0x10, 255, 0x02, 2]);
});

test("uint8 Message Parameter Value は範囲外を拒否する", () => {
  assert.throws(
    () => encodeUint8ParameterValue(256, "SUBSCRIBER_PRIORITY"),
    /invalid SUBSCRIBER_PRIORITY value: 256, expected 0\.\.255/,
  );
});

/**
 * Track Namespace / Full Track Name のサイズ制限テスト
 * draft-ietf-moq-transport-18:
 * Track Namespace と Full Track Name は最大 4,096 バイト。
 * draft-ietf-moq-transport-18 Section 10.2
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

test("decodeTrackNamespace で Field Length=0 のフィールドはエラー", () => {
  // draft-ietf-moq-transport-18 §2.3:
  // "Each Track Namespace Field Value MUST contain at least one byte."
  // 要素数 1、長さ 0 のデータを作成
  const countBytes = encodeVarint(1n);
  const lengthBytes = encodeVarint(0n);

  const encoded = new Uint8Array(countBytes.length + lengthBytes.length);
  encoded.set(countBytes, 0);
  encoded.set(lengthBytes, countBytes.length);

  assert.throws(() => decodeTrackNamespace(encoded), /track namespace field length is zero/);
});

test("decodeTrackNamespace で複数フィールドの 1 つでも長さ 0 ならエラー", () => {
  // 要素数 2、最初のフィールドは "a"、2 つ目が長さ 0
  const countBytes = encodeVarint(2n);
  const firstLenBytes = encodeVarint(1n);
  const firstDataBytes = new Uint8Array([0x61]); // "a"
  const secondLenBytes = encodeVarint(0n);

  const totalLength =
    countBytes.length + firstLenBytes.length + firstDataBytes.length + secondLenBytes.length;
  const encoded = new Uint8Array(totalLength);
  let pos = 0;
  encoded.set(countBytes, pos);
  pos += countBytes.length;
  encoded.set(firstLenBytes, pos);
  pos += firstLenBytes.length;
  encoded.set(firstDataBytes, pos);
  pos += firstDataBytes.length;
  encoded.set(secondLenBytes, pos);

  assert.throws(() => decodeTrackNamespace(encoded), /track namespace field length is zero/);
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

/**
 * 未知 Message Parameter 受信時の PROTOCOL_VIOLATION テスト
 * draft-ietf-moq-transport-18 Section 10.2:
 * "An endpoint that receives an unknown Message Parameter MUST close
 *  the session with PROTOCOL_VIOLATION."
 */
test("未知のパラメータタイプで ProtocolViolationError", () => {
  // type = 0xFE (未知), value = 0x01 (varint)
  const countBytes = encodeVarint(1n);
  const deltaTypeBytes = encodeVarint(0xfen);
  const valueBytes = encodeVarint(1n);
  const data = new Uint8Array(countBytes.length + deltaTypeBytes.length + valueBytes.length);
  data.set(countBytes, 0);
  data.set(deltaTypeBytes, countBytes.length);
  data.set(valueBytes, countBytes.length + deltaTypeBytes.length);

  assert.throws(() => decodeParameters(data), /unknown message parameter type/);
});

/**
 * 重複 Message Parameter 検出の SHOULD テスト
 * draft-ietf-moq-transport-18 Section 10.2:
 * "Receivers SHOULD check that there are no unexpected duplicate parameters
 *  and close the session with PROTOCOL_VIOLATION if found."
 */
test("重複パラメータで ProtocolViolationError", () => {
  // type = 0x02 を 2 回含むデータ
  const countBytes = encodeVarint(2n);
  const firstDeltaBytes = encodeVarint(0x02n);
  const firstValueBytes = encodeVarint(100n);
  const secondDeltaBytes = encodeVarint(0x00n); // delta = 0 (前回と同じ type)
  const secondValueBytes = encodeVarint(200n);

  const data = new Uint8Array(
    countBytes.length +
      firstDeltaBytes.length +
      firstValueBytes.length +
      secondDeltaBytes.length +
      secondValueBytes.length,
  );
  let pos = 0;
  data.set(countBytes, pos);
  pos += countBytes.length;
  data.set(firstDeltaBytes, pos);
  pos += firstDeltaBytes.length;
  data.set(firstValueBytes, pos);
  pos += firstValueBytes.length;
  data.set(secondDeltaBytes, pos);
  pos += secondDeltaBytes.length;
  data.set(secondValueBytes, pos);

  assert.throws(() => decodeParameters(data), /duplicate message parameter type/);
});
