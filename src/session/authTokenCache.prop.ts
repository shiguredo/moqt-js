/**
 * AuthTokenCache Property-Based Tests
 * draft-ietf-moq-transport-17 Section 9.3.2, 9.4.1.3, 9.4.1.4
 */

import * as fc from "fast-check";
import { assert, test } from "vite-plus/test";
import { SessionErrorCode } from "../error";
import { AuthTokenCache } from "./authTokenCache";

test("maxSize 0 のキャッシュは REGISTER を常に容量超過として拒否する", () => {
  fc.assert(
    fc.property(
      fc.bigInt({ min: 0n, max: 1000n }),
      fc.bigInt({ min: 0n, max: 0xffffn }),
      fc.uint8Array({ maxLength: 8 }),
      (alias, tokenType, tokenValue) => {
        const cache = new AuthTokenCache(0n);
        const ok = cache.tryRegister(alias, tokenType, tokenValue);
        assert.equal(ok, false);
        assert.equal(cache.size, 0);
      },
    ),
  );
});

test("容量に余裕があれば REGISTER が成功する", () => {
  fc.assert(
    fc.property(
      fc.bigInt({ min: 0n, max: 1000n }),
      fc.bigInt({ min: 0n, max: 0xffffn }),
      fc.uint8Array({ maxLength: 16 }),
      (alias, tokenType, tokenValue) => {
        // 16 バイト + Token Value バイト数の容量を確保
        const size = 16n + BigInt(tokenValue.length);
        const cache = new AuthTokenCache(size);
        assert.equal(cache.tryRegister(alias, tokenType, tokenValue), true);
        assert.equal(cache.size, 1);
        assert.equal(cache.totalSize, size);
      },
    ),
  );
});

test("同じ alias の二重 REGISTER は DUPLICATE_AUTH_TOKEN_ALIAS", () => {
  const cache = new AuthTokenCache(100n);
  assert.equal(cache.tryRegister(1n, 0n, new Uint8Array([1, 2])), true);
  let caught: unknown;
  try {
    cache.tryRegister(1n, 0n, new Uint8Array([3, 4]));
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof Error);
  assert.equal((caught as { code?: number }).code, SessionErrorCode.DUPLICATE_AUTH_TOKEN_ALIAS);
});

test("resolve は登録された Token Type / Value を返す", () => {
  const cache = new AuthTokenCache(100n);
  const value = new Uint8Array([1, 2, 3]);
  cache.tryRegister(5n, 7n, value);
  const resolved = cache.resolve(5n);
  assert.ok(resolved);
  assert.equal(resolved.tokenType, 7n);
  assert.deepEqual(resolved.tokenValue, value);
});

test("未登録 alias の resolve は undefined", () => {
  const cache = new AuthTokenCache(100n);
  assert.equal(cache.resolve(99n), undefined);
});

test("delete は totalSize を適切に減らし isEmpty を true にする", () => {
  const cache = new AuthTokenCache(100n);
  cache.tryRegister(1n, 0n, new Uint8Array([1, 2, 3]));
  cache.tryRegister(2n, 0n, new Uint8Array([4]));
  const sizeBefore = cache.totalSize;
  cache.delete(1n);
  assert.equal(cache.totalSize, sizeBefore - (16n + 3n));
  assert.equal(cache.resolve(1n), undefined);
  cache.delete(2n);
  assert.ok(cache.isEmpty);
});

test("未登録 alias の delete は no-op", () => {
  const cache = new AuthTokenCache(100n);
  cache.delete(999n);
  assert.equal(cache.size, 0);
  assert.equal(cache.totalSize, 0n);
});

test("容量を一部超えると新規 REGISTER は false になる", () => {
  // maxSize = 30 バイト (1 エントリ分ほど)
  const cache = new AuthTokenCache(30n);
  assert.equal(cache.tryRegister(1n, 0n, new Uint8Array(10)), true); // 16 + 10 = 26
  // 次のエントリは 16 + 10 = 26 必要。26 + 26 = 52 > 30 なので拒否
  assert.equal(cache.tryRegister(2n, 0n, new Uint8Array(10)), false);
  assert.equal(cache.size, 1);
});
