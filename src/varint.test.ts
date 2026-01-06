import { test, assert } from "vitest";
import { encodeVarint, decodeVarint } from "./varint";

test("encodeVarint: 0 をエンコード", () => {
  const encoded = encodeVarint(0);
  assert.deepEqual(encoded, new Uint8Array([0x00]));
});

test("encodeVarint: 63 をエンコード (1 バイト最大)", () => {
  const encoded = encodeVarint(63);
  assert.deepEqual(encoded, new Uint8Array([0x3f]));
});

test("encodeVarint: 64 をエンコード (2 バイト最小)", () => {
  const encoded = encodeVarint(64);
  assert.deepEqual(encoded, new Uint8Array([0x40, 0x40]));
});

test("encodeVarint: 16383 をエンコード (2 バイト最大)", () => {
  const encoded = encodeVarint(16383);
  assert.deepEqual(encoded, new Uint8Array([0x7f, 0xff]));
});

test("encodeVarint: 16384 をエンコード (4 バイト最小)", () => {
  const encoded = encodeVarint(16384);
  assert.deepEqual(encoded, new Uint8Array([0x80, 0x00, 0x40, 0x00]));
});

test("encodeVarint: 1073741823 をエンコード (4 バイト最大)", () => {
  const encoded = encodeVarint(1073741823);
  assert.deepEqual(encoded, new Uint8Array([0xbf, 0xff, 0xff, 0xff]));
});

test("encodeVarint: 1073741824 をエンコード (8 バイト最小)", () => {
  const encoded = encodeVarint(1073741824);
  assert.deepEqual(encoded, new Uint8Array([0xc0, 0x00, 0x00, 0x00, 0x40, 0x00, 0x00, 0x00]));
});

test("decodeVarint: 0 をデコード", () => {
  const data = new Uint8Array([0x00]);
  const [value, consumed] = decodeVarint(data);
  assert.equal(value, 0n);
  assert.equal(consumed, 1);
});

test("decodeVarint: 63 をデコード", () => {
  const data = new Uint8Array([0x3f]);
  const [value, consumed] = decodeVarint(data);
  assert.equal(value, 63n);
  assert.equal(consumed, 1);
});

test("decodeVarint: 64 をデコード (2 バイト)", () => {
  const data = new Uint8Array([0x40, 0x40]);
  const [value, consumed] = decodeVarint(data);
  assert.equal(value, 64n);
  assert.equal(consumed, 2);
});

test("decodeVarint: 16383 をデコード", () => {
  const data = new Uint8Array([0x7f, 0xff]);
  const [value, consumed] = decodeVarint(data);
  assert.equal(value, 16383n);
  assert.equal(consumed, 2);
});

test("decodeVarint: 16384 をデコード (4 バイト)", () => {
  const data = new Uint8Array([0x80, 0x00, 0x40, 0x00]);
  const [value, consumed] = decodeVarint(data);
  assert.equal(value, 16384n);
  assert.equal(consumed, 4);
});

test("decodeVarint: 1073741823 をデコード", () => {
  const data = new Uint8Array([0xbf, 0xff, 0xff, 0xff]);
  const [value, consumed] = decodeVarint(data);
  assert.equal(value, 1073741823n);
  assert.equal(consumed, 4);
});

test("decodeVarint: 1073741824 をデコード (8 バイト)", () => {
  const data = new Uint8Array([0xc0, 0x00, 0x00, 0x00, 0x40, 0x00, 0x00, 0x00]);
  const [value, consumed] = decodeVarint(data);
  assert.equal(value, 1073741824n);
  assert.equal(consumed, 8);
});

test("decodeVarint: データ不足でエラー", () => {
  const data = new Uint8Array([0x40]);
  assert.throws(() => decodeVarint(data));
});
