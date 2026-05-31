/**
 * MOQT 可変長整数エンコーディング テスト
 * draft-ietf-moq-transport-18 Section 1.4.1
 */

import { test, assert } from "vite-plus/test";
import { encodeVarint, decodeVarint, varintSize } from "./varint";
import { IncompleteDataError, ProtocolViolationError } from "./error";

// 1 バイト (0xxxxxxx): 0-127
test("encodeVarint: 0 をエンコード", () => {
  assert.deepEqual(encodeVarint(0), new Uint8Array([0x00]));
});

test("encodeVarint: 37 をエンコード", () => {
  assert.deepEqual(encodeVarint(37), new Uint8Array([0x25]));
});

test("encodeVarint: 127 をエンコード (1 バイト最大)", () => {
  assert.deepEqual(encodeVarint(127), new Uint8Array([0x7f]));
});

// 2 バイト (10xxxxxx): 128-16383
test("encodeVarint: 128 をエンコード (2 バイト最小)", () => {
  assert.deepEqual(encodeVarint(128), new Uint8Array([0x80, 0x80]));
});

test("encodeVarint: 16383 をエンコード (2 バイト最大)", () => {
  assert.deepEqual(encodeVarint(16383), new Uint8Array([0xbf, 0xff]));
});

// 3 バイト (110xxxxx): 16384-2097151
test("encodeVarint: 16384 をエンコード (3 バイト最小)", () => {
  assert.deepEqual(encodeVarint(16384), new Uint8Array([0xc0, 0x40, 0x00]));
});

test("encodeVarint: 2097151 をエンコード (3 バイト最大)", () => {
  assert.deepEqual(encodeVarint(2097151), new Uint8Array([0xdf, 0xff, 0xff]));
});

// 4 バイト (1110xxxx): 2097152-268435455
test("encodeVarint: 2097152 をエンコード (4 バイト最小)", () => {
  assert.deepEqual(encodeVarint(2097152), new Uint8Array([0xe0, 0x20, 0x00, 0x00]));
});

test("encodeVarint: 268435455 をエンコード (4 バイト最大)", () => {
  assert.deepEqual(encodeVarint(268435455), new Uint8Array([0xef, 0xff, 0xff, 0xff]));
});

// 5 バイト (11110xxx): 268435456-34359738367
test("encodeVarint: 268435456 をエンコード (5 バイト最小)", () => {
  assert.deepEqual(encodeVarint(268435456n), new Uint8Array([0xf0, 0x10, 0x00, 0x00, 0x00]));
});

// 6 バイト (111110xx): 34359738368-4398046511103
test("encodeVarint: 34359738368 をエンコード (6 バイト最小)", () => {
  assert.deepEqual(
    encodeVarint(34359738368n),
    new Uint8Array([0xf8, 0x08, 0x00, 0x00, 0x00, 0x00]),
  );
});

// 8 バイト (11111110): 4398046511104-72057594037927935
test("encodeVarint: 4398046511104 をエンコード (8 バイト最小)", () => {
  assert.deepEqual(
    encodeVarint(4398046511104n),
    new Uint8Array([0xfe, 0x00, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00]),
  );
});

// 9 バイト (11111111): 72057594037927936-18446744073709551615
test("encodeVarint: 最大値をエンコード", () => {
  assert.deepEqual(
    encodeVarint(18446744073709551615n),
    new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]),
  );
});

// デコードテスト: ラウンドトリップ
test("decodeVarint: 0 をデコード", () => {
  const [value, consumed] = decodeVarint(new Uint8Array([0x00]));
  assert.equal(value, 0n);
  assert.equal(consumed, 1);
});

test("decodeVarint: 127 をデコード (1 バイト最大)", () => {
  const [value, consumed] = decodeVarint(new Uint8Array([0x7f]));
  assert.equal(value, 127n);
  assert.equal(consumed, 1);
});

test("decodeVarint: 128 をデコード (2 バイト)", () => {
  const [value, consumed] = decodeVarint(new Uint8Array([0x80, 0x80]));
  assert.equal(value, 128n);
  assert.equal(consumed, 2);
});

test("decodeVarint: 16383 をデコード (2 バイト最大)", () => {
  const [value, consumed] = decodeVarint(new Uint8Array([0xbf, 0xff]));
  assert.equal(value, 16383n);
  assert.equal(consumed, 2);
});

test("decodeVarint: 16384 をデコード (3 バイト)", () => {
  const [value, consumed] = decodeVarint(new Uint8Array([0xc0, 0x40, 0x00]));
  assert.equal(value, 16384n);
  assert.equal(consumed, 3);
});

test("decodeVarint: 268435455 をデコード (4 バイト最大)", () => {
  const [value, consumed] = decodeVarint(new Uint8Array([0xef, 0xff, 0xff, 0xff]));
  assert.equal(value, 268435455n);
  assert.equal(consumed, 4);
});

test("decodeVarint: 最大値をデコード (9 バイト)", () => {
  const [value, consumed] = decodeVarint(
    new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]),
  );
  assert.equal(value, 18446744073709551615n);
  assert.equal(consumed, 9);
});

test("decodeVarint: データ不足は IncompleteDataError", () => {
  assert.throws(() => decodeVarint(new Uint8Array(0)), IncompleteDataError);
  assert.throws(() => decodeVarint(new Uint8Array([0x80])), IncompleteDataError);
});

test("decodeVarint: 無効なコードポイント 0xFC は ProtocolViolationError", () => {
  assert.throws(() => decodeVarint(new Uint8Array([0xfc])), ProtocolViolationError);
});

test("decodeVarint: 無効なコードポイント 0xFD は ProtocolViolationError", () => {
  assert.throws(() => decodeVarint(new Uint8Array([0xfd])), ProtocolViolationError);
});

// varintSize テスト
test("varintSize: 各範囲で正しいサイズを返す", () => {
  assert.equal(varintSize(0), 1);
  assert.equal(varintSize(127), 1);
  assert.equal(varintSize(128), 2);
  assert.equal(varintSize(16383), 2);
  assert.equal(varintSize(16384), 3);
  assert.equal(varintSize(2097151), 3);
  assert.equal(varintSize(2097152), 4);
  assert.equal(varintSize(268435455), 4);
  assert.equal(varintSize(268435456), 5);
  assert.equal(varintSize(34359738367n), 5);
  assert.equal(varintSize(34359738368n), 6);
  assert.equal(varintSize(4398046511103n), 6);
  assert.equal(varintSize(4398046511104n), 8);
  assert.equal(varintSize(72057594037927935n), 8);
  assert.equal(varintSize(72057594037927936n), 9);
});
